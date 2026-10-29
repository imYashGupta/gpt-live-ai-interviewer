import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServicePool, migrateService, transaction } from '../lib/interview-service/postgres.ts';
import { provisionAccount, authenticate, newId } from '../lib/interview-service/security.ts';
import { InterviewService } from '../lib/interview-service/service.ts';
import { exchangeInvitation, startCandidate } from '../lib/interview-service/candidate.ts';
import { openRecording, issueChunk, confirmChunk } from '../lib/interview-service/recordings.ts';
import { recordIntegrityEvents, integritySummary } from '../lib/interview-service/integrity.ts';
import { handleCandidate } from '../lib/interview-service/http.ts';
const url=process.env.INTERVIEW_TEST_DATABASE_URL || process.env.INTERVIEW_DATABASE_URL;
if (!url && process.env.INTERVIEW_DATABASE_TEST_REQUIRED==='true') throw new Error('Existing Herd database required');

test('integrity signals on disposable Herd fixtures', {skip:!url}, async t => {
  const schema='integrity_test_'+randomBytes(8).toString('hex'), admin=createServicePool(url);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool=createServicePool(url,schema); await migrateService(pool);
    const service=new InterviewService(pool,randomBytes(32),'https://interviewer.test');
    const account=await transaction(pool,db=>provisionAccount(db,'Integrity'));
    const p=await authenticate(pool,`Bearer ${account.token}`);
    const ws=await service.createWorkspace(p,{external_reference:newId('team'),display_name:'Integrity'},newId('cmd'));
    async function candidate(start=true){
      const now=Date.now(),last=new Date(now+120000).toISOString();
      const input={workspace_id:ws.id,external_reference:newId('external'),candidate:{external_id:'person',display_name:'Synthetic Candidate'},job:{external_id:'job',title:'Engineer',description:'Synthetic'},configuration:{mode:'adaptive',modality:'audio',language:'en',duration_limit_seconds:60,difficulty:'mid',follow_ups_enabled:true,interviewer_profile_id:'sandbox_default',rubric_version_id:'sandbox_v1'},availability:{kind:'window',opens_at:new Date(now-1000).toISOString(),last_start_at:last,must_finish_at:new Date(now+240000).toISOString(),display_timezone:'UTC'},authorization_budget:{external_reservation_id:newId('hold'),metric:'interview_seconds',max_quantity:60,start_before:last}};
      const row=await service.createInterview(p,input,newId('cmd'));
      const link=await service.accessLink(p,row.id,{expires_at:last},newId('cmd'));
      const session=await exchangeInvitation(service,new URL(link.url).hash.slice(1));
      if(start)await startCandidate(service,session.token);
      const attemptId=(await pool.query('SELECT attempt_id FROM service_interviews WHERE id=$1',[row.id])).rows[0].attempt_id;
      return {interviewId:row.id,attemptId,token:session.token};
    }
    const status=(code,s)=>e=>e.status===s&&e.code===code;
    const send=(c,events)=>recordIntegrityEvents(service,c.token,{events});
    const summary=attemptId=>transaction(pool,db=>integritySummary(db,attemptId));

    await t.test('batches are validated strictly',async()=>{
      const c=await candidate();
      for (const bad of [null,[],{},{events:[]},{events:'x'},{events:[{type:'tab_hidden',offset_ms:1}],extra:1},
        {events:Array.from({length:51},()=>({type:'tab_hidden',offset_ms:1}))},
        {events:[{type:'screenshot',offset_ms:1}]},{events:[{type:'tab_hidden',offset_ms:-1}]},
        {events:[{type:'tab_hidden',offset_ms:1.5}]},{events:[{type:'tab_hidden',offset_ms:7_200_001}]},
        {events:[{type:'tab_hidden',offset_ms:'1'}]},{events:[{type:'tab_hidden',offset_ms:1,note:'x'}]}])
        await assert.rejects(recordIntegrityEvents(service,c.token,bad),status('validation_failed',422));
    });

    await t.test('events need the candidate session of a started attempt inside its window',async()=>{
      const event=[{type:'tab_hidden',offset_ms:1}];
      await assert.rejects(recordIntegrityEvents(service,null,{events:event}),status('invalid_session',401));
      const notStarted=await candidate(false);
      await assert.rejects(send(notStarted,event),status('not_started',409));
      const c=await candidate();
      await pool.query("UPDATE service_attempts SET ended_at=now()-interval '6 minutes' WHERE id=$1",[c.attemptId]);
      await assert.rejects(send(c,event),status('recording_closed',409));
    });

    await t.test('summary measures hidden and unfocused time and counts camera loss',async()=>{
      const c=await candidate();
      await pool.query("UPDATE service_attempts SET started_at=now()-interval '60 seconds',ended_at=now() WHERE id=$1",[c.attemptId]);
      assert.deepEqual(await send(c,[
        {type:'window_blur',offset_ms:1000},{type:'tab_hidden',offset_ms:1000},{type:'tab_visible',offset_ms:4000},
        {type:'window_focus',offset_ms:5000},{type:'camera_lost',offset_ms:20000},
      ]),{accepted:5});
      // A tab hidden until the end counts to the end of the attempt.
      await send(c,[{type:'tab_hidden',offset_ms:50000},{type:'window_blur',offset_ms:50000}]);
      const s=await summary(c.attemptId);
      assert.deepEqual(s.tab_hidden,{count:2,seconds:13});
      assert.deepEqual(s.focus_lost,{count:2,seconds:14});
      assert.equal(s.camera_lost,1);
      assert.equal(s.recording_unavailable,false);
      assert.equal(s.recording,null);
      assert.equal(s.events.length,7);
      assert.deepEqual(s.events[0],{type:'window_blur',offset_ms:1000});
    });

    await t.test('summary reports recording gaps and refusal',async()=>{
      const c=await candidate();
      const rec=await transaction(pool,db=>openRecording(db,{accountId:p.accountId,interviewId:c.interviewId,attemptId:c.attemptId},'interviews/','video/webm','video_v1'));
      for (const sequence of [0,1,2,3]) await transaction(pool,db=>issueChunk(db,rec.id,sequence));
      for (const sequence of [0,2]) await transaction(pool,db=>confirmChunk(db,rec.id,sequence,100));
      const s=await summary(c.attemptId);
      assert.deepEqual(s.recording,{status:'recording',missing_chunks:2,missing_seconds_estimate:20});
      const refused=await candidate();
      await send(refused,[{type:'recording_unavailable',offset_ms:200}]);
      assert.equal((await summary(refused.attemptId)).recording_unavailable,true);
    });

    await t.test('each attempt stores at most 1000 events',async()=>{
      const c=await candidate();
      await pool.query("INSERT INTO service_integrity_events(attempt_id,type,offset_ms) SELECT $1,'window_blur',g FROM generate_series(1,990) g",[c.attemptId]);
      const batch=Array.from({length:50},(_,i)=>({type:'window_focus',offset_ms:2000+i}));
      assert.deepEqual(await send(c,batch),{accepted:10});
      assert.deepEqual(await send(c,batch.slice(0,5)),{accepted:0});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM service_integrity_events WHERE attempt_id=$1',[c.attemptId])).rows[0].n,1000);
    });

    await t.test('HTTP route enforces origin and session',async()=>{
      const c=await candidate();
      const post=(headers={})=>handleCandidate(new Request('https://interviewer.test/candidate/integrity',{method:'POST',
        headers:{origin:'https://interviewer.test','content-type':'application/json',cookie:`__Host-interview_session=${c.token}`,...headers},
        body:JSON.stringify({events:[{type:'tab_hidden',offset_ms:10}]})}),service);
      assert.equal((await post({origin:'https://evil.test'})).status,403);
      assert.equal((await post({cookie:''})).status,401);
      const ok=await post();
      assert.equal(ok.status,200); assert.deepEqual(await ok.json(),{accepted:1});
    });
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
