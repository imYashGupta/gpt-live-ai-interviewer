import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { importLegacy } from '../lib/interview-service/legacy.ts';
import { randomBytes } from 'node:crypto';
import { createServicePool, migrateService, transaction } from '../lib/interview-service/postgres.ts';
import { provisionAccount, authenticate, hashToken, newId, newToken } from '../lib/interview-service/security.ts';
import { InterviewService } from '../lib/interview-service/service.ts';
import { handleApi, handleCandidate } from '../lib/interview-service/http.ts';
import { exchangeInvitation, startCandidate } from '../lib/interview-service/candidate.ts';
import { claimJob, runClaimedJob, runWorkerOnce, expireInvitations } from '../lib/interview-service/worker.ts';
import { signWebhook } from '../lib/interview-service/webhook-signature.ts';
import { validate } from '../lib/interview-service/validation.ts';

const connection = process.env.INTERVIEW_TEST_DATABASE_URL || process.env.INTERVIEW_DATABASE_URL;
if (!connection && process.env.INTERVIEW_DATABASE_TEST_REQUIRED === 'true') throw new Error('A Herd PostgreSQL connection is required for database tests');

test('PostgreSQL service integration on configured server', {skip:!connection}, async t => {
  const schema='interview_test_'+randomBytes(8).toString('hex');
  const admin=createServicePool(connection);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=createServicePool(connection,schema);
    await migrateService(pool);
    await migrateService(pool); // Repeated operator migration is harmless.
    const encryptionKey=randomBytes(32),origin='https://interviewer.test';
    let service=new InterviewService(pool,encryptionKey,origin);
    const account=await transaction(pool,db=>provisionAccount(db,'Recooty test'));
    const other=await transaction(pool,db=>provisionAccount(db,'Other client'));
    const p=await authenticate(pool,`Bearer ${account.token}`);
    const stranger=await authenticate(pool,`Bearer ${other.token}`);
    const makeWorkspace=()=>service.createWorkspace(p,{external_reference:newId('team'),display_name:'Test team'},newId('cmd'));
    const workspace=await makeWorkspace();
    function request(workspaceId=workspace.id) {
      const now=Date.now();
      return {workspace_id:workspaceId,external_reference:newId('application'),candidate:{external_id:'candidate1',display_name:'Candidate'},
        job:{external_id:'job1',title:'Engineer',description:'Job context'},configuration:{mode:'adaptive',modality:'audio',language:'en',duration_limit_seconds:60,difficulty:'mid',follow_ups_enabled:true,interviewer_profile_id:'sandbox_default',rubric_version_id:'sandbox_v1'},
        availability:{kind:'window',opens_at:new Date(now-1000).toISOString(),last_start_at:new Date(now+120000).toISOString(),must_finish_at:new Date(now+240000).toISOString(),display_timezone:'Asia/Kolkata'},
        authorization_budget:{external_reservation_id:newId('hold'),metric:'interview_seconds',max_quantity:60,start_before:new Date(now+180000).toISOString()}};
    }
    async function invited(workspaceId=workspace.id) {
      const input=request(workspaceId);
      const interview=await service.createInterview(p,input,newId('cmd'));
      const link=await service.accessLink(p,interview.id,{expires_at:input.availability.last_start_at},newId('cmd'));
      const token=new URL(link.url).hash.slice(1);
      return {input,interview,link,token};
    }
    const api=(path,method='GET',body,token=account.token,key)=>handleApi(new Request(origin+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),service);
    let interview;
    await t.test('scoped authentication, schema validation, and tenant isolation',async()=>{
      assert.equal((await api('/v1/capabilities','GET',undefined,'invalid')).status,401);
      const caps=await (await api('/v1/capabilities')).json(); validate('Capabilities',caps);
      const input=request();
      assert.equal((await api('/v1/interviews','POST',input)).status,422);
      assert.equal((await api('/v1/interviews','POST',{...input,provider:'openai'},account.token,'invalid')).status,422);
      interview=await service.createInterview(p,input,'create-initial'); validate('Interview',interview);
      await assert.rejects(service.readInterview(stranger,interview.id),e=>e.status===404);
      await assert.rejects(service.createInterview(stranger,request(),newId('cmd')),e=>e.status===404);
      assert.equal((await api(`/v1/interviews/${interview.id}`,'GET',undefined,other.token)).status,404);
      const scopedToken=newToken('isk_test');
      await pool.query(`INSERT INTO service_credentials(id,account_id,workspace_id,token_hash,scopes,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day')`,[newId('key'),p.accountId,workspace.id,hashToken(scopedToken),['interviews:read']]);
      const scoped=await service.principal(`Bearer ${scopedToken}`);
      assert.equal((await service.readInterview(scoped,interview.id)).id,interview.id);
      await assert.rejects(service.createInterview(scoped,request(),newId('cmd')),e=>e.status===403);
      const secondWorkspace=await makeWorkspace();
      const cross=await service.createInterview(p,request(secondWorkspace.id),newId('cmd'));
      await assert.rejects(service.readInterview(scoped,cross.id),e=>e.status===404);
      await pool.query('UPDATE service_credentials SET revoked_at=now() WHERE token_hash=$1',[hashToken(scopedToken)]);
      await assert.rejects(service.principal(`Bearer ${scopedToken}`),e=>e.status===401);
    });
    await t.test('concurrent idempotency survives new connections and credential rotation',async()=>{
      const input=request(),key=newId('command');
      const responses=await Promise.all(Array.from({length:8},()=>service.createInterview(p,input,key)));
      assert.equal(new Set(responses.map(r=>r.id)).size,1);
      const reversed=Object.fromEntries(Object.entries(input).reverse());
      assert.deepEqual(await service.createInterview(p,reversed,key),responses[0]);
      await assert.rejects(service.createInterview(p,{...input,external_reference:'different'},key),e=>e.code==='idempotency_conflict');
      const rotated=newToken('isk_test');
      await pool.query(`INSERT INTO service_credentials(id,account_id,token_hash,scopes,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 day')`,[newId('key'),p.accountId,hashToken(rotated),['interviews:write']]);
      const rotatedPrincipal=await service.principal(`Bearer ${rotated}`);
      await pool.end(); pool=createServicePool(connection,schema); service=new InterviewService(pool,encryptionKey,origin);
      assert.deepEqual(await service.createInterview(rotatedPrincipal,input,key),responses[0]);
      const row=(await pool.query('SELECT response_ciphertext FROM service_commands WHERE command_key=$1',[key])).rows[0];
      assert.ok(!row.response_ciphertext.includes(responses[0].id));
    });
    await t.test('scanner GET and cross-origin POST cannot consume invitations; sessions are private',async()=>{
      const {token,interview}=await invited();
      const get=await handleCandidate(new Request(origin+'/candidate/exchange?token='+token),service); assert.equal(get.status,404);
      const exchange=(originHeader)=>handleCandidate(new Request(origin+'/candidate/exchange',{method:'POST',headers:{Origin:originHeader,'Content-Type':'application/json'},body:JSON.stringify({token})}),service);
      assert.equal((await exchange('https://attacker.test')).status,403);
      const result=await exchange(origin); assert.equal(result.status,200);
      const cookie=result.headers.get('set-cookie');
      assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
      assert.equal((await exchange(origin)).status,401);
      const status=await handleCandidate(new Request(origin+'/candidate/session',{headers:{Cookie:cookie.split(';')[0]}}),service);
      const data=await status.json(); assert.equal(data.interview_id,interview.id);
      assert.equal(data.authorization_budget,undefined); assert.equal(data.candidate,undefined);
      const records=await pool.query('SELECT token_hash FROM service_access_links WHERE interview_id=$1',[interview.id]);
      assert.notEqual(records.rows[0].token_hash,token);
    });
    await t.test('link replacement and cancellation revoke old candidate sessions',async()=>{
      const item=await invited(); const session=await exchangeInvitation(service,item.token);
      await service.accessLink(p,item.interview.id,{expires_at:item.input.availability.last_start_at},newId('cmd'));
      await assert.rejects(startCandidate(service,session.token),e=>e.status===401);
      const cancelled=await service.cancel(p,item.interview.id,{expected_resource_version:1,reason:'employer_request'},newId('cmd'));
      assert.equal(cancelled.execution_status,'cancelled');
      await assert.rejects(service.accessLink(p,item.interview.id,{expires_at:item.input.availability.last_start_at},newId('cmd')),e=>e.status===409);
    });
    await t.test('concurrent starts allocate one attempt and enforce workspace quotas',async()=>{
      const ws=await makeWorkspace(); await pool.query('UPDATE service_workspaces SET concurrency_limit=1,allowance_seconds=60 WHERE id=$1',[ws.id]);
      const a=await invited(ws.id),b=await invited(ws.id);
      const sa=await exchangeInvitation(service,a.token),sb=await exchangeInvitation(service,b.token);
      const starts=await Promise.all(Array.from({length:8},()=>startCandidate(service,sa.token)));
      assert.equal(new Set(starts.map(s=>s.attempt_id)).size,1);
      await assert.rejects(startCandidate(service,sb.token),e=>e.code==='concurrency_limit');
      await service.cancel(p,a.interview.id,{expected_resource_version:2,reason:'employer_request'},newId('cmd'));
      const cancelledUsage=(await service.usage(p,ws.id,null)).data.find(u=>u.interview_id===a.interview.id);
      assert.equal(cancelledUsage.measured_quantity,0);assert.equal(cancelledUsage.billable_quantity,0);
      assert.ok((await startCandidate(service,sb.token)).attempt_id);
      const ws2=await makeWorkspace(); await pool.query('UPDATE service_workspaces SET allowance_seconds=59 WHERE id=$1',[ws2.id]);
      const c=await invited(ws2.id); const sc=await exchangeInvitation(service,c.token);
      await assert.rejects(startCandidate(service,sc.token),e=>e.code==='quota_exceeded');
    });
    await t.test('future/expired windows cannot start or mint usable links',async()=>{
      const input=request(); input.availability.opens_at=new Date(Date.now()+60000).toISOString();
      const i=await service.createInterview(p,input,newId('cmd'));
      const l=await service.accessLink(p,i.id,{expires_at:input.availability.last_start_at},newId('cmd'));
      const s=await exchangeInvitation(service,new URL(l.url).hash.slice(1));
      await assert.rejects(startCandidate(service,s.token),e=>e.code==='interview_not_open');
      await assert.rejects(service.accessLink(p,i.id,{expires_at:new Date(Date.now()-1000).toISOString()},newId('cmd')),e=>e.status===422);
    });
    await t.test('expiry emits one durable event and invalidates access without a charge',async()=>{
      const item=await invited(); const session=await exchangeInvitation(service,item.token);
      await pool.query("UPDATE service_interviews SET request=jsonb_set(request,'{availability,last_start_at}',to_jsonb((now()-interval '1 minute')::text)) WHERE id=$1",[item.interview.id]);
      assert.equal(await expireInvitations(service),1); assert.equal(await expireInvitations(service),0);
      assert.equal((await service.readInterview(p,item.interview.id)).execution_status,'expired');
      await assert.rejects(startCandidate(service,session.token),e=>e.status===401);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM service_usage WHERE record->>\'interview_id\'=$1',[item.interview.id])).rows[0].n,0);
    });
    await t.test('legacy import is read-only, repeatable, internal/demo and cannot generate usage',async()=>{
      const dir=await mkdtemp(join(tmpdir(),'interview-legacy-test-')); const file=join(dir,'legacy.sqlite');
      try {
        const sqlite=new Database(file);
        sqlite.exec("CREATE TABLE interviews(id TEXT PRIMARY KEY,mode TEXT,role TEXT,difficulty TEXT,planned_minutes INTEGER,actual_seconds REAL,status TEXT,started_at TEXT,ended_at TEXT); INSERT INTO interviews VALUES ('legacy1','ai-led','Engineer','mid',10,40,'completed','2026-01-01','2026-01-01')");
        sqlite.close();
        assert.equal(await importLegacy(pool,file),1); assert.equal(await importLegacy(pool,file),0);
        const archive=(await pool.query("SELECT snapshot FROM service_legacy_imports WHERE legacy_id='legacy1'")).rows[0].snapshot;
        assert.equal(archive.classification,'internal_demo');assert.equal(archive.billable,false);
        assert.equal((await pool.query("SELECT count(*)::integer AS n FROM service_interviews WHERE id='legacy1'")).rows[0].n,0);
      } finally { await rm(dir,{recursive:true,force:true}); }
    });
    await t.test('worker lease recovery, persisted evidence, zero-charge settlement and signed outbox',async()=>{
      // Drain earlier test execution without performing any network I/O.
      while(await runWorkerOnce(service,async()=>{})) {}
      const endpoint=await service.webhookEndpoint(p,{url:'https://receiver.example/webhook',event_types:['interview.started','interview.completed','usage.settled','result.ready']},newId('cmd'));
      assert.equal(endpoint.status,'pending_verification');
      await pool.query("UPDATE service_webhook_endpoints SET status='active' WHERE id=$1",[endpoint.id]);
      const item=await invited(); const session=await exchangeInvitation(service,item.token);
      await startCandidate(service,session.token);
      await pool.query("UPDATE service_jobs SET available_at=now()-interval '1 minute' WHERE kind='execute' AND interview_id=$1",[item.interview.id]);
      const abandoned=await claimJob(service); assert.equal(abandoned.kind,'execute');
      await pool.query("UPDATE service_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[abandoned.id]);
      const recovered=await claimJob(service); assert.equal(recovered.id,abandoned.id); assert.notEqual(recovered.lease_token,abandoned.lease_token);
      await runClaimedJob(service,abandoned,async()=>assert.fail('Stale worker delivered data'));
      assert.equal((await service.readInterview(p,item.interview.id)).execution_status,'in_progress');
      // Simulate restart: a fresh service/pool resumes the persisted lease and data.
      await pool.end();pool=createServicePool(connection,schema);service=new InterviewService(pool,encryptionKey,origin);
      await runClaimedJob(service,recovered,async()=>{});
      const deliveries=[];
      while(await runWorkerOnce(service,async(url,body,headers)=>deliveries.push({url,body,headers}))) {}
      const state=await service.readInterview(p,item.interview.id);
      assert.equal(state.execution_status,'completed'); assert.equal(state.assessment_status,'insufficient_evidence');
      const result=await service.readResult(p,item.interview.id); validate('Result',result); assert.equal(result.transcript.length,2); assert.equal(result.overall_score,null);
      const usage=await service.usage(p,workspace.id,null); validate('UsagePage',usage);
      const settlement=usage.data.find(u=>u.interview_id===item.interview.id); assert.equal(settlement.measured_quantity,10); assert.equal(settlement.billable_quantity,0); assert.equal(settlement.credit_quantity,'0.000000');
      assert.equal(deliveries.length,4);
      for(const delivery of deliveries) {
        validate('Event',JSON.parse(delivery.body));
        assert.deepEqual(delivery.headers,signWebhook(delivery.body,delivery.headers['Interview-Event-Id'],Number(delivery.headers['Interview-Timestamp']),endpoint.signing_secret));
      }
      assert.equal((await startCandidate(service,session.token)).attempt_id,state.attempt_id);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM service_usage WHERE attempt_id=$1',[state.attempt_id])).rows[0].n,1);
      await runClaimedJob(service,recovered,async()=>assert.fail('Completed job delivered again'));
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM service_usage WHERE attempt_id=$1',[state.attempt_id])).rows[0].n,1);
    });
    await t.test('delivery failures back off, dead-letter and replay the same event',async()=>{
      const event=(await pool.query('SELECT * FROM service_jobs WHERE kind=\'deliver\' LIMIT 1')).rows[0];
      await pool.query("UPDATE service_jobs SET status='pending',attempts=0,available_at=now() WHERE id=$1",[event.id]);
      for(let i=0;i<6;i++) {
        await runWorkerOnce(service,async()=>{throw new Error('Secret should never persist');});
        await pool.query('UPDATE service_jobs SET available_at=now() WHERE id=$1',[event.id]);
      }
      let stored=(await pool.query('SELECT * FROM service_jobs WHERE id=$1',[event.id])).rows[0];
      assert.equal(stored.status,'dead');assert.equal(stored.last_error,'job_failed');
      await pool.query("UPDATE service_jobs SET status='pending',attempts=0,available_at=now() WHERE id=$1",[event.id]);
      let delivered;
      await runWorkerOnce(service,async(_url,body)=>{delivered=JSON.parse(body);});
      assert.equal(delivered.id,event.event_id);
      stored=(await pool.query('SELECT * FROM service_jobs WHERE id=$1',[event.id])).rows[0]; assert.equal(stored.status,'done');
    });
    await t.test('lost receiver acknowledgment survives restart without changing event or settlement identity',async()=>{
      const delivery=(await pool.query("SELECT * FROM service_jobs WHERE kind='deliver' AND event_id IN (SELECT id FROM service_events WHERE body::jsonb->>'type'='result.ready') LIMIT 1")).rows[0];
      const usageBefore=(await pool.query('SELECT count(*)::integer AS n FROM service_usage')).rows[0].n;
      await pool.query("UPDATE service_jobs SET status='pending',attempts=0,available_at=now() WHERE id=$1",[delivery.id]);
      const received=[];
      const lost=await claimJob(service);
      assert.equal(lost.id,delivery.id);
      await runClaimedJob(service,lost,async(_url,body,headers)=>{
        received.push({body,headers});
        throw new Error('Receiver accepted the event but the acknowledgment was lost');
      });
      const pending=(await pool.query('SELECT status,available_at FROM service_jobs WHERE id=$1',[delivery.id])).rows[0];
      assert.equal(pending.status,'pending');
      assert.ok(new Date(pending.available_at).getTime()>Date.now());
      await pool.end();pool=createServicePool(connection,schema);service=new InterviewService(pool,encryptionKey,origin);
      await pool.query('UPDATE service_jobs SET available_at=now() WHERE id=$1',[delivery.id]);
      await runWorkerOnce(service,async(_url,body,headers)=>received.push({body,headers}));
      assert.equal(received.length,2);
      assert.equal(received[0].body,received[1].body);
      assert.equal(received[0].headers['Interview-Event-Id'],received[1].headers['Interview-Event-Id']);
      assert.equal(JSON.parse(received[1].body).id,delivery.event_id);
      assert.equal((await pool.query('SELECT status FROM service_jobs WHERE id=$1',[delivery.id])).rows[0].status,'done');
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM service_usage')).rows[0].n,usageBefore);
    });
  } finally {
    await pool?.end();
    // This identifier is generated locally; no configured/public schema is ever dropped.
    if(/^interview_test_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
