import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { createServicePool, migrateService, transaction } from '../lib/interview-service/postgres.ts';
import { provisionAccount, authenticate, newId } from '../lib/interview-service/security.ts';
import { InterviewService } from '../lib/interview-service/service.ts';
import { exchangeInvitation, startCandidate } from '../lib/interview-service/candidate.ts';
import { RecordingStorage, recordingStorageConfig } from '../lib/interview-service/recording-storage.ts';
import { openRecording, issueChunk, confirmChunk, scheduleRecordingJobs, readArtifacts } from '../lib/interview-service/recordings.ts';
import { recordIntegrityEvents, readIntegrity } from '../lib/interview-service/integrity.ts';
import { runClaimedJob } from '../lib/interview-service/worker.ts';
import { handleApi } from '../lib/interview-service/http.ts';
const url=process.env.INTERVIEW_TEST_DATABASE_URL || process.env.INTERVIEW_DATABASE_URL;
if (!url && process.env.INTERVIEW_DATABASE_TEST_REQUIRED==='true') throw new Error('Existing Herd database required');

test('recording API and deletion on disposable Herd fixtures', {skip:!url}, async t => {
  const schema='recording_api_test_'+randomBytes(8).toString('hex'), admin=createServicePool(url);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool=createServicePool(url,schema); await migrateService(pool);
    const service=new InterviewService(pool,randomBytes(32),'https://interviewer.test');
    // In-memory S3; presigning is real and offline.
    const objects=new Map(); let failDelete=false;
    const client=new S3Client({region:'ap-south-1',credentials:{accessKeyId:'AKIAOFFLINETEST',secretAccessKey:'offline-secret'}});
    client.send=async command=>{
      const name=command.constructor.name, input=command.input;
      if (name==='GetObjectCommand') { const bytes=objects.get(input.Key); return {Body:{transformToByteArray:async()=>bytes}}; }
      if (name==='CreateMultipartUploadCommand') { client.parts=[]; return {UploadId:'up'}; }
      if (name==='UploadPartCommand') { client.parts.push(input.Body); return {ETag:'e'+input.PartNumber}; }
      if (name==='CompleteMultipartUploadCommand') { objects.set(input.Key,Buffer.concat(client.parts)); return {}; }
      if (name==='ListObjectsV2Command') return {Contents:[...objects.keys()].filter(k=>k.startsWith(input.Prefix)).map(Key=>({Key})),IsTruncated:false};
      if (name==='DeleteObjectsCommand') { if (failDelete) throw new Error('S3 outage'); for (const o of input.Delete.Objects) objects.delete(o.Key); return {}; }
      throw new Error(`unexpected ${name}`);
    };
    const storage=new RecordingStorage(recordingStorageConfig({INTERVIEW_RECORDING_ENABLED:'true',INTERVIEW_RECORDING_S3_BUCKET:'recordings-test',INTERVIEW_RECORDING_S3_REGION:'ap-south-1'}),client);
    service.recording=storage;
    async function client_(name){
      const account=await transaction(pool,db=>provisionAccount(db,name));
      return {token:account.token,p:await authenticate(pool,`Bearer ${account.token}`)};
    }
    const a=await client_('Api A'), b=await client_('Api B');
    const ws=await service.createWorkspace(a.p,{external_reference:newId('team'),display_name:'Api'},newId('cmd'));
    async function interview({start=true,chunks=[0,1],finalize=true}={}){
      const now=Date.now(),last=new Date(now+120000).toISOString();
      const input={workspace_id:ws.id,external_reference:newId('external'),candidate:{external_id:'person',display_name:'Synthetic Candidate'},job:{external_id:'job',title:'Engineer',description:'Synthetic'},configuration:{mode:'adaptive',modality:'audio',language:'en',duration_limit_seconds:60,difficulty:'mid',follow_ups_enabled:true,interviewer_profile_id:'sandbox_default',rubric_version_id:'sandbox_v1'},availability:{kind:'window',opens_at:new Date(now-1000).toISOString(),last_start_at:last,must_finish_at:new Date(now+240000).toISOString(),display_timezone:'UTC'},authorization_budget:{external_reservation_id:newId('hold'),metric:'interview_seconds',max_quantity:60,start_before:last}};
      const row=await service.createInterview(a.p,input,newId('cmd'));
      if (!start) return {id:row.id};
      const link=await service.accessLink(a.p,row.id,{expires_at:last},newId('cmd'));
      const session=await exchangeInvitation(service,new URL(link.url).hash.slice(1));
      await startCandidate(service,session.token);
      const attemptId=(await pool.query('SELECT attempt_id FROM service_interviews WHERE id=$1',[row.id])).rows[0].attempt_id;
      const rec=await transaction(pool,db=>openRecording(db,{accountId:a.p.accountId,interviewId:row.id,attemptId},'interviews/','video/webm','video_v1'));
      for (const sequence of chunks) {
        const chunk=await transaction(pool,db=>issueChunk(db,rec.id,sequence));
        objects.set(chunk.object_key,Buffer.from(`[${sequence}]`));
        await transaction(pool,db=>confirmChunk(db,rec.id,sequence,3));
      }
      await recordIntegrityEvents(service,session.token,{events:[{type:'tab_hidden',offset_ms:1000},{type:'tab_visible',offset_ms:3000}]});
      if (finalize) {
        await pool.query("UPDATE service_attempts SET ended_at=now()-interval '10 minutes' WHERE id=$1",[attemptId]);
        await scheduleRecordingJobs(service);
        await run('recording',row.id);
      }
      return {id:row.id,attemptId,rec};
    }
    async function run(kind,id){
      const job=(await pool.query("UPDATE service_jobs SET status='running',attempts=attempts+1,lease_token=$3,lease_until=now()+interval '30 seconds' WHERE kind=$1 AND interview_id=$2 AND status='pending' RETURNING *",[kind,id,newId('lease')])).rows[0];
      assert.ok(job,`${kind} job queued`);
      await runClaimedJob(service,job,async()=>{});
    }
    const prefixObjects=prefix=>[...objects.keys()].filter(k=>k.startsWith(prefix));

    await t.test('artifacts list the joined recording with a short-lived link',async()=>{
      const f=await interview();
      const page=await readArtifacts(service,a.p,f.id);
      assert.equal(page.data.length,1);
      const [artifact]=page.data;
      assert.equal(artifact.kind,'video_recording'); assert.equal(artifact.content_type,'video/webm'); assert.equal(artifact.id,f.rec.id);
      const link=new URL(artifact.url);
      assert.equal(link.pathname,`/${f.rec.object_prefix}recording.webm`);
      assert.equal(link.searchParams.get('X-Amz-Expires'),'900');
      assert.ok(Date.parse(artifact.expires_at)-Date.now()<=900_000);
      const http=await handleApi(new Request(`https://interviewer.test/v1/interviews/${f.id}/artifacts`,{headers:{authorization:`Bearer ${a.token}`}}),service);
      assert.equal(http.status,200); assert.equal((await http.json()).data[0].kind,'video_recording');
    });

    await t.test('artifacts are empty until a playable file exists',async()=>{
      assert.deepEqual((await readArtifacts(service,a.p,(await interview({start:false})).id)).data,[]);
      assert.deepEqual((await readArtifacts(service,a.p,(await interview({finalize:false})).id)).data,[]);
      assert.deepEqual((await readArtifacts(service,a.p,(await interview({chunks:[1]})).id)).data,[]);
      const incomplete=await interview({chunks:[0,2]});
      assert.equal((await readArtifacts(service,a.p,incomplete.id)).data.length,1);
      service.recording=undefined;
      try { assert.deepEqual((await readArtifacts(service,a.p,incomplete.id)).data,[]); } finally { service.recording=storage; }
    });

    await t.test('integrity summary is available to the owning client only',async()=>{
      const f=await interview({chunks:[0,2]});
      const summary=await readIntegrity(service,a.p,f.id);
      assert.equal(summary.attempt_id,f.attemptId);
      assert.deepEqual(summary.tab_hidden,{count:1,seconds:2});
      assert.deepEqual(summary.recording,{status:'incomplete',missing_chunks:1,missing_seconds_estimate:10});
      await assert.rejects(readIntegrity(service,a.p,(await interview({start:false})).id),e=>e.status===409&&e.code==='not_started');
      for (const read of [readArtifacts,readIntegrity]) {
        await assert.rejects(read(service,b.p,f.id),e=>e.status===404);
        await assert.rejects(read(service,{...a.p,scopes:['interviews:write']},f.id),e=>e.status===403);
      }
      const http=await handleApi(new Request(`https://interviewer.test/v1/interviews/${f.id}/integrity`,{headers:{authorization:`Bearer ${b.token}`}}),service);
      assert.equal(http.status,404);
    });

    await t.test('deletion erases signals at once and purges objects after upload links expire',async()=>{
      const f=await interview();
      assert.equal(prefixObjects(f.rec.object_prefix).length,1);
      await service.deleteInterview(a.p,f.id,newId('cmd'));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM service_integrity_events WHERE attempt_id=$1',[f.attemptId])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM service_recording_chunks WHERE recording_id=$1',[f.rec.id])).rows[0].n,0);
      const rec=(await pool.query('SELECT * FROM service_recordings WHERE id=$1',[f.rec.id])).rows[0];
      assert.equal(rec.status,'deleted'); assert.equal(rec.object_key,null); assert.equal(rec.deleted_at,null);
      await assert.rejects(readArtifacts(service,a.p,f.id),e=>e.status===410);
      // First pass purges, then waits for links issued before deletion to expire.
      await run('delete',f.id);
      assert.equal(prefixObjects(f.rec.object_prefix).length,0);
      assert.equal((await service.deletionStatus(a.p,f.id)).blocker,'recording_purge_pending');
      objects.set(`${f.rec.object_prefix}chunks/00009.webm`,Buffer.from('late upload'));
      await pool.query("UPDATE service_interviews SET deletion_requested_at=now()-interval '10 minutes' WHERE id=$1",[f.id]);
      await run('delete',f.id);
      assert.equal(prefixObjects(f.rec.object_prefix).length,0);
      assert.equal((await service.deletionStatus(a.p,f.id)).status,'deleted');
      assert.ok((await pool.query('SELECT deleted_at FROM service_recordings WHERE id=$1',[f.rec.id])).rows[0].deleted_at);
    });

    await t.test('deletion waits for storage, failed purges and running joins',async()=>{
      const f=await interview({finalize:false});
      await service.deleteInterview(a.p,f.id,newId('cmd'));
      await pool.query("UPDATE service_interviews SET deletion_requested_at=now()-interval '10 minutes' WHERE id=$1",[f.id]);
      service.recording=undefined;
      try { await run('delete',f.id); } finally { service.recording=storage; }
      assert.equal((await service.deletionStatus(a.p,f.id)).blocker,'recording_storage_unavailable');
      failDelete=true;
      try { await run('delete',f.id); } finally { failDelete=false; }
      assert.equal((await service.deletionStatus(a.p,f.id)).blocker,'recording_delete_failed');
      assert.equal(prefixObjects(f.rec.object_prefix).length,2);
      await pool.query("INSERT INTO service_jobs(id,kind,dedupe_key,interview_id,status,lease_token,lease_until) VALUES ($1,'recording',$2,$3,'running','lease_x',now()+interval '1 minute')",[newId('job'),`recording:${f.rec.id}`,f.id]);
      await run('delete',f.id);
      assert.equal((await service.deletionStatus(a.p,f.id)).blocker,'recording_purge_pending');
      await pool.query("UPDATE service_jobs SET lease_until=now()-interval '1 second' WHERE kind='recording' AND interview_id=$1",[f.id]);
      await run('delete',f.id);
      assert.equal((await service.deletionStatus(a.p,f.id)).status,'deleted');
      assert.equal(prefixObjects(f.rec.object_prefix).length,0);
      assert.equal((await pool.query("SELECT status FROM service_jobs WHERE kind='recording' AND interview_id=$1",[f.id])).rows[0].status,'done');
    });

    await t.test('a join finishing after deletion does not restore the recording',async()=>{
      const f=await interview({finalize:false});
      await pool.query("UPDATE service_attempts SET ended_at=now()-interval '10 minutes' WHERE id=$1",[f.attemptId]);
      await scheduleRecordingJobs(service);
      const job=(await pool.query("UPDATE service_jobs SET status='running',attempts=1,lease_token='lease_join',lease_until=now()+interval '30 seconds' WHERE kind='recording' AND interview_id=$1 RETURNING *",[f.id])).rows[0];
      // Deletion lands while the join is in progress.
      const original=storage.join.bind(storage);
      storage.join=async(...args)=>{ const bytes=await original(...args); await service.deleteInterview(a.p,f.id,newId('cmd')); return bytes; };
      try { await runClaimedJob(service,job,async()=>{}); } finally { storage.join=original; }
      const rec=(await pool.query('SELECT status,object_key FROM service_recordings WHERE id=$1',[f.rec.id])).rows[0];
      assert.deepEqual(rec,{status:'deleted',object_key:null});
      await pool.query("UPDATE service_interviews SET deletion_requested_at=now()-interval '10 minutes' WHERE id=$1",[f.id]);
      await run('delete',f.id);
      assert.equal(prefixObjects(f.rec.object_prefix).length,0);
    });
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
