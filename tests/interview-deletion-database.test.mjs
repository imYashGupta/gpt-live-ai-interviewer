import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServicePool, migrateService, transaction } from '../lib/interview-service/postgres.ts';
import { provisionAccount, authenticate, newId, unseal } from '../lib/interview-service/security.ts';
import { InterviewService } from '../lib/interview-service/service.ts';
import { exchangeInvitation, startCandidate, candidateStatus } from '../lib/interview-service/candidate.ts';
import { claimJob, runClaimedJob } from '../lib/interview-service/worker.ts';
import { handleApi } from '../lib/interview-service/http.ts';
const url=process.env.INTERVIEW_TEST_DATABASE_URL || process.env.INTERVIEW_DATABASE_URL;
if (!url && process.env.INTERVIEW_DATABASE_TEST_REQUIRED==='true') throw new Error('Existing Herd database required');
test('durable deletion on disposable Herd fixtures', {skip:!url},async t=>{
  const schema='delete_test_'+randomBytes(8).toString('hex'), admin=createServicePool(url);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool=createServicePool(url,schema); await migrateService(pool);
    const key=randomBytes(32), account=await transaction(pool,db=>provisionAccount(db,'Synthetic deletion'));
    const p=await authenticate(pool,`Bearer ${account.token}`), stranger={...p,accountId:'acct_other'};
    let creates=0,hangups=0,failStop=false,duringCreate=async()=>{}, duringAssess=async()=>{}, events=[];
    const live={accountIds:[p.accountId],provider:{
      async create(){creates++; await duringCreate(); return {reference:'private_'+newId('call'),answer:'private-answer'};},
      attach(){return {ready:Promise.resolve(),updateTimeRemaining(){},stop(){events.push({id:'closed',kind:'execution.closed',cumulativeAudioMs:12000,outcome:'completed'});},close(){},async next(){return events.shift() ?? {id:'closed',kind:'execution.closed',cumulativeAudioMs:12000,outcome:'completed'};}};},
      async hangup(){hangups++; if(failStop)throw new Error('mock outage');}
    },assessor:{async assess(){await duringAssess();return {summary:'Private result',competencies:[]};}}};
    const service=new InterviewService(pool,key,'https://interviewer.test',live);
    const ws=await service.createWorkspace(p,{external_reference:newId('team'),display_name:'Synthetic'},newId('cmd'));
    async function fixture(start=false,fake=false){
      service.live.accountIds=fake?[]:[p.accountId];
      const now=Date.now(),last=new Date(now+120000).toISOString(),command=newId('cmd');
      const input={workspace_id:ws.id,external_reference:newId('external'),candidate:{external_id:'private-person-id',display_name:'Private Candidate'},job:{external_id:'private-job-id',title:'Engineer',description:'Private context'},configuration:{mode:'adaptive',modality:'audio',language:'en',duration_limit_seconds:60,difficulty:'mid',follow_ups_enabled:true,interviewer_profile_id:fake?'sandbox_default':'pilot_default',rubric_version_id:fake?'sandbox_v1':'pilot_v1'},availability:{kind:'window',opens_at:new Date(now-1000).toISOString(),last_start_at:last,must_finish_at:new Date(now+240000).toISOString(),display_timezone:'UTC'},authorization_budget:{external_reservation_id:newId('hold'),metric:'interview_seconds',max_quantity:60,start_before:last}};
      const row=await service.createInterview(p,input,command),linkKey=newId('cmd');
      const link=await service.accessLink(p,row.id,{expires_at:last},linkKey),session=await exchangeInvitation(service,new URL(link.url).hash.slice(1));
      if(start)await startCandidate(service,session.token,fake?{}:{sdp:'v=0\r\nsynthetic',consent_version:'transcript_v1'});
      return {row,input,command,linkKey,session};
    }
    async function run(kind,id){
      await pool.query("UPDATE service_jobs SET available_at=now() WHERE kind=$1 AND interview_id=$2",[kind,id]);
      const job=await transaction(pool,async db=>{
        const r=(await db.query("SELECT * FROM service_jobs WHERE kind=$1 AND interview_id=$2 AND status IN ('pending','running') LIMIT 1",[kind,id])).rows[0];
        if(!r)return null;
        return (await db.query("UPDATE service_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '30 seconds' WHERE id=$1 RETURNING *",[r.id,newId('lease')])).rows[0];
      });
      assert.ok(job); await runClaimedJob(service,job,async()=>{});return job;
    }
    await t.test('tenant scope, HTTP acceptance, revocation and idempotent erasure including legacy responses',async()=>{
      const f=await fixture();
      await pool.query('UPDATE service_commands SET interview_id=NULL WHERE interview_id=$1',[f.row.id]);
      await assert.rejects(service.deleteInterview(stranger,f.row.id,'delete'),e=>e.status===404);
      await assert.rejects(service.deleteInterview({...p,workspaceId:'ws_other'},f.row.id,'delete'),e=>e.status===404);
      await assert.rejects(service.deleteInterview({...p,scopes:['interviews:read']},f.row.id,'delete'),e=>e.status===403);
      const response=await handleApi(new Request(`https://interviewer.test/v1/interviews/${f.row.id}`,{method:'DELETE',headers:{authorization:`Bearer ${account.token}`,'idempotency-key':'delete'}}),service);
      assert.equal(response.status,202);
      assert.equal((await service.deleteInterview(p,f.row.id,'delete')).status,'deletion_pending');
      await assert.rejects(candidateStatus(service,f.session.token),e=>e.status===401);
      await assert.rejects(startCandidate(service,f.session.token),e=>e.status===401);
      await assert.rejects(service.readResult(p,f.row.id),e=>e.status===410);
      await assert.rejects(service.createInterview(p,f.input,f.command),e=>e.status===410);
      await assert.rejects(service.createInterview(p,f.input,newId('cmd')),e=>e.status===410);
      await assert.rejects(service.accessLink(p,f.row.id,{expires_at:f.input.availability.last_start_at},f.linkKey),e=>e.status===410);
      await run('delete',f.row.id);
      assert.equal((await service.deletionStatus(p,f.row.id)).status,'deleted');
      const row=(await pool.query('SELECT * FROM service_interviews WHERE id=$1',[f.row.id])).rows[0];
      assert.deepEqual(row.request,{});assert.equal(row.external_reference,row.id);
      const commands=(await pool.query("SELECT * FROM service_commands WHERE interview_id=$1 AND operation NOT LIKE 'interview.delete:%'",[row.id])).rows;
      assert.ok(commands.length>=2);for(const c of commands)assert.equal(unseal(c.response_ciphertext,key),'{}');
      assert.equal((await pool.query('SELECT * FROM service_events WHERE interview_id=$1',[row.id])).rows[0].type,'interview.deleted');
      assert.equal((await pool.query('SELECT * FROM service_candidate_sessions WHERE interview_id=$1',[row.id])).rowCount,0);
    });
    await t.test('queued deletion starts no provider and stale lease cannot recreate data',async()=>{
      const f=await fixture(true),old=await claimJob(service),before=creates;
      assert.equal(old.kind,'execute');
      await service.deleteInterview(p,f.row.id,newId('cmd'));
      await run('delete',f.row.id); assert.equal((await service.deletionStatus(p,f.row.id)).blocker,'execution_stopping');
      await runClaimedJob(service,old,async()=>{});
      await run('delete',f.row.id);
      assert.equal(creates,before);assert.equal((await service.deletionStatus(p,f.row.id)).status,'deleted');
      await runClaimedJob(service,old,async()=>{});
      assert.deepEqual((await pool.query('SELECT transcript,result,observations FROM service_attempts WHERE interview_id=$1',[f.row.id])).rows[0],{transcript:[],result:null,observations:{}});
    });
    await t.test('deletion racing provider creation drains active execution and drops late evidence',async()=>{
      const f=await fixture(true);
      duringCreate=async()=>{await service.deleteInterview(p,f.row.id,newId('cmd'));await run('delete',f.row.id);};
      events=[{id:'late',kind:'transcript.fragment',speaker:'candidate',text:'Private late answer',startMs:0,endMs:1000}];
      await run('execute',f.row.id);duringCreate=async()=>{};
      await run('delete',f.row.id);
      assert.equal((await service.deletionStatus(p,f.row.id)).status,'deleted');
      assert.equal((await pool.query('SELECT * FROM service_observations')).rowCount,0);
      assert.deepEqual((await service.usage(p,ws.id,null)).data,[]);
      const usage=(await pool.query('SELECT u.record FROM service_usage u JOIN service_attempts a ON a.id=u.attempt_id WHERE a.interview_id=$1',[f.row.id])).rows[0].record;
      assert.equal(usage.measured_quantity,12);assert.equal(usage.external_reference,undefined);assert.equal(usage.external_reservation_id,undefined);
    });
    await t.test('concurrent start/delete and new-key create replay cannot resurrect the interview',async()=>{
      const f=await fixture(false,true);
      const results=await Promise.allSettled([startCandidate(service,f.session.token),service.deleteInterview(p,f.row.id,newId('cmd'))]);
      assert.equal(results[1].status,'fulfilled');
      await run('delete',f.row.id);
      const retries=await Promise.allSettled(Array.from({length:4},()=>service.createInterview(p,f.input,newId('cmd'))));
      assert.ok(retries.every(r=>r.status==='rejected' && [409,410].includes(r.reason.status)));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM service_interviews WHERE external_reference_hash=(SELECT external_reference_hash FROM service_interviews WHERE id=$1)',[f.row.id])).rows[0].n,1);
      await assert.rejects(service.deletionStatus(stranger,f.row.id),e=>e.status===404);
    });
    await t.test('cleanup transaction failure retries after restart without a premature deleted event',async()=>{
      const f=await fixture();await service.deleteInterview(p,f.row.id,newId('cmd'));
      await pool.query("CREATE FUNCTION reject_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='interview.deleted' THEN RAISE EXCEPTION 'mock failure'; END IF; RETURN NEW; END $$");
      await pool.query('CREATE TRIGGER reject_deleted BEFORE INSERT ON service_events FOR EACH ROW EXECUTE FUNCTION reject_deleted()');
      await run('delete',f.row.id);
      assert.equal((await service.deletionStatus(p,f.row.id)).status,'deletion_pending');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM service_events WHERE interview_id=$1 AND type='interview.deleted'",[f.row.id])).rows[0].n,0);
      await pool.query('DROP TRIGGER reject_deleted ON service_events');
      const replacement=new InterviewService(pool,key,'https://interviewer.test',live);
      await service.deleteInterview(p,f.row.id,newId('cmd'));
      await run('delete',f.row.id);
      assert.equal((await replacement.deletionStatus(p,f.row.id)).status,'deleted');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM service_events WHERE interview_id=$1 AND type='interview.deleted'",[f.row.id])).rows[0].n,1);
    });
    await t.test('stop failures retry and unknown creation stays pending without a purge claim',async()=>{
      const f=await fixture(true);
      await pool.query("UPDATE service_attempts SET connection_state='observing',provider_reference='known_mock_reference' WHERE interview_id=$1",[f.row.id]);
      await service.deleteInterview(p,f.row.id,newId('cmd'));failStop=true;
      await run('delete',f.row.id);assert.equal((await service.deletionStatus(p,f.row.id)).blocker,'provider_stop_failed');
      failStop=false;await run('delete',f.row.id);assert.equal((await service.deletionStatus(p,f.row.id)).status,'deleted');assert.ok(hangups>=2);
      const u=await fixture(true);await pool.query("UPDATE service_attempts SET connection_state='creating' WHERE interview_id=$1",[u.row.id]);
      await service.deleteInterview(p,u.row.id,newId('cmd'));await run('delete',u.row.id);
      assert.equal((await service.deletionStatus(p,u.row.id)).blocker,'provider_outcome_unknown');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM service_events WHERE interview_id=$1 AND type='interview.deleted'",[u.row.id])).rows[0].n,0);
    });
    await t.test('assessment response after deletion is fenced',async()=>{
      const f=await fixture(true);
      events=[{id:'answer',kind:'transcript.fragment',speaker:'candidate',text:'A sufficiently detailed private answer for the assessment threshold.',startMs:0,endMs:1000}];
      await run('execute',f.row.id);
      duringAssess=async()=>{await service.deleteInterview(p,f.row.id,newId('cmd'));await run('delete',f.row.id);};
      await run('assess',f.row.id);duringAssess=async()=>{};
      assert.equal((await pool.query('SELECT result FROM service_attempts WHERE interview_id=$1',[f.row.id])).rows[0].result,null);
      assert.equal((await service.deletionStatus(p,f.row.id)).status,'deleted');
    });
  }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
