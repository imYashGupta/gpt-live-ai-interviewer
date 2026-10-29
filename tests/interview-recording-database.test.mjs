import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServicePool, migrateService, transaction } from '../lib/interview-service/postgres.ts';
import { provisionAccount, authenticate, newId } from '../lib/interview-service/security.ts';
import { InterviewService } from '../lib/interview-service/service.ts';
import { exchangeInvitation, startCandidate } from '../lib/interview-service/candidate.ts';
import {
  openRecording, recordingForInterview, issueChunk, confirmChunk, recordingChunks, missingChunks,
} from '../lib/interview-service/recordings.ts';
const url=process.env.INTERVIEW_TEST_DATABASE_URL || process.env.INTERVIEW_DATABASE_URL;
if (!url && process.env.INTERVIEW_DATABASE_TEST_REQUIRED==='true') throw new Error('Existing Herd database required');

test('missing chunks are the gaps before the highest confirmed sequence', () => {
  const at = new Date();
  assert.deepEqual(missingChunks([]), []);
  assert.deepEqual(missingChunks([{ sequence: 0, confirmed_at: null }]), []);
  assert.deepEqual(missingChunks([0, 1, 2].map(sequence => ({ sequence, confirmed_at: at }))), []);
  assert.deepEqual(missingChunks([{ sequence: 0, confirmed_at: at }, { sequence: 1, confirmed_at: null }, { sequence: 3, confirmed_at: at }]), [1, 2]);
  assert.deepEqual(missingChunks([{ sequence: 2, confirmed_at: at }]), [0, 1]);
});

test('recording rows on disposable Herd fixtures', {skip:!url}, async t => {
  const schema='recording_test_'+randomBytes(8).toString('hex'), admin=createServicePool(url);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool=createServicePool(url,schema); await migrateService(pool);
    const service=new InterviewService(pool,randomBytes(32),'https://interviewer.test');
    async function client(name){
      const account=await transaction(pool,db=>provisionAccount(db,name));
      const p=await authenticate(pool,`Bearer ${account.token}`);
      const ws=await service.createWorkspace(p,{external_reference:newId('team'),display_name:name},newId('cmd'));
      return {p,ws};
    }
    // Synthetic interviews create real attempt rows without any provider.
    async function attempt({p,ws}){
      const now=Date.now(),last=new Date(now+120000).toISOString();
      const input={workspace_id:ws.id,external_reference:newId('external'),candidate:{external_id:'person',display_name:'Synthetic Candidate'},job:{external_id:'job',title:'Engineer',description:'Synthetic'},configuration:{mode:'adaptive',modality:'audio',language:'en',duration_limit_seconds:60,difficulty:'mid',follow_ups_enabled:true,interviewer_profile_id:'sandbox_default',rubric_version_id:'sandbox_v1'},availability:{kind:'window',opens_at:new Date(now-1000).toISOString(),last_start_at:last,must_finish_at:new Date(now+240000).toISOString(),display_timezone:'UTC'},authorization_budget:{external_reservation_id:newId('hold'),metric:'interview_seconds',max_quantity:60,start_before:last}};
      const row=await service.createInterview(p,input,newId('cmd'));
      const link=await service.accessLink(p,row.id,{expires_at:last},newId('cmd'));
      const session=await exchangeInvitation(service,new URL(link.url).hash.slice(1));
      await startCandidate(service,session.token);
      const started=(await pool.query('SELECT attempt_id FROM service_interviews WHERE id=$1',[row.id])).rows[0];
      return {accountId:p.accountId,interviewId:row.id,attemptId:started.attempt_id};
    }
    const a=await client('Recording A'), b=await client('Recording B');
    const open=(ids,type='video/webm;codecs=vp8,opus')=>transaction(pool,db=>openRecording(db,ids,'interviews/',type,'video_v1'));

    await t.test('opening is idempotent per attempt and pins the type and prefix',async()=>{
      const ids=await attempt(a);
      const first=await open(ids), again=await open(ids);
      assert.equal(again.id,first.id);
      assert.equal(first.content_type,'video/webm');
      assert.equal(first.status,'recording');
      assert.equal(first.object_prefix,`interviews/${ids.accountId}/${ids.interviewId}/${ids.attemptId}/`);
      await assert.rejects(open(ids,'video/mp4'),e=>e.status===409&&e.code==='recording_type_changed');
      await assert.rejects(open(ids,'text/html'));
      await assert.rejects(open({...ids,accountId:'acct_other'}),e=>e.status===409);
      await assert.rejects(transaction(pool,db=>openRecording(db,ids,'interviews/','video/webm','bad version!')),e=>e.status===422);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM service_recordings WHERE attempt_id=$1',[ids.attemptId])).rows[0].n,1);
    });

    await t.test('lookup is scoped to the owning account',async()=>{
      const ids=await attempt(a); const rec=await open(ids);
      assert.equal((await transaction(pool,db=>recordingForInterview(db,a.p.accountId,ids.interviewId))).id,rec.id);
      assert.equal(await transaction(pool,db=>recordingForInterview(db,b.p.accountId,ids.interviewId)),null);
      const other=await attempt(b); const otherRec=await open(other);
      assert.notEqual(otherRec.object_prefix,rec.object_prefix);
      assert.ok(otherRec.object_prefix.startsWith(`interviews/${b.p.accountId}/`));
    });

    await t.test('chunks are issued once, retried while unconfirmed, and confirmed idempotently',async()=>{
      const rec=await open(await attempt(a));
      const issued=await transaction(pool,db=>issueChunk(db,rec.id,0));
      assert.equal(issued.object_key,`${rec.object_prefix}chunks/00000.webm`);
      const retried=await transaction(pool,db=>issueChunk(db,rec.id,0));
      assert.equal(retried.object_key,issued.object_key);
      await assert.rejects(transaction(pool,db=>confirmChunk(db,rec.id,1,100)),e=>e.status===404&&e.code==='chunk_not_issued');
      const confirmed=await transaction(pool,db=>confirmChunk(db,rec.id,0,1500));
      assert.equal(Number(confirmed.bytes),1500); assert.ok(confirmed.confirmed_at);
      assert.equal(Number((await transaction(pool,db=>confirmChunk(db,rec.id,0,1500))).bytes),1500);
      await assert.rejects(transaction(pool,db=>confirmChunk(db,rec.id,0,9)),e=>e.status===409&&e.code==='chunk_size_mismatch');
      await assert.rejects(transaction(pool,db=>issueChunk(db,rec.id,0)),e=>e.status===409&&e.code==='chunk_already_uploaded');
      for (const bad of [-1,100000,1.5]) await assert.rejects(transaction(pool,db=>issueChunk(db,rec.id,bad)),e=>e.status===422);
      for (const bad of [0,-5,Number.NaN]) await assert.rejects(transaction(pool,db=>confirmChunk(db,rec.id,0,bad)),e=>e.status===422);
    });

    await t.test('gaps are visible from the stored chunks',async()=>{
      const rec=await open(await attempt(a));
      for (const sequence of [0,1,2,3]) await transaction(pool,db=>issueChunk(db,rec.id,sequence));
      for (const sequence of [0,3]) await transaction(pool,db=>confirmChunk(db,rec.id,sequence,1000));
      const chunks=await transaction(pool,db=>recordingChunks(db,rec.id));
      assert.deepEqual(chunks.map(c=>c.sequence),[0,1,2,3]);
      assert.deepEqual(missingChunks(chunks),[1,2]);
    });

    await t.test('closed or deleted recordings accept no new chunks',async()=>{
      const rec=await open(await attempt(a));
      await pool.query("UPDATE service_recordings SET status='finalizing' WHERE id=$1",[rec.id]);
      await assert.rejects(transaction(pool,db=>issueChunk(db,rec.id,0)),e=>e.status===409&&e.code==='recording_closed');
      await pool.query("UPDATE service_recordings SET deleted_at=now() WHERE id=$1",[rec.id]);
      await assert.rejects(transaction(pool,db=>issueChunk(db,rec.id,0)),e=>e.status===404);
      await assert.rejects(transaction(pool,db=>issueChunk(db,'rec_missing',0)),e=>e.status===404);
    });

    await t.test('constraints reject inconsistent rows written outside these functions',async()=>{
      const rec=await open(await attempt(a));
      await assert.rejects(pool.query("INSERT INTO service_recording_chunks(recording_id,sequence,object_key,bytes) VALUES ($1,0,'k-unconfirmed',10)",[rec.id]));
      await assert.rejects(pool.query("UPDATE service_recordings SET status='uploaded' WHERE id=$1",[rec.id]));
      await assert.rejects(pool.query("INSERT INTO service_recordings(id,account_id,interview_id,attempt_id,object_prefix,content_type,consent_version) VALUES ('rec_x',$1,'int_missing','att_missing','p/','video/webm','v1')",[a.p.accountId]));
    });

    await t.test('concurrent opens and issues for one attempt converge',async()=>{
      const ids=await attempt(a);
      const opened=await Promise.all(Array.from({length:5},()=>open(ids)));
      assert.equal(new Set(opened.map(r=>r.id)).size,1);
      const issued=await Promise.all(Array.from({length:5},()=>transaction(pool,db=>issueChunk(db,opened[0].id,4))));
      assert.equal(new Set(issued.map(c=>c.object_key)).size,1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM service_recording_chunks WHERE recording_id=$1',[opened[0].id])).rows[0].n,1);
    });
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
