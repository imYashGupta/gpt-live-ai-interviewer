import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServicePool, migrateService, transaction } from '../lib/interview-service/postgres.ts';
import { provisionAccount, authenticate, newId } from '../lib/interview-service/security.ts';
import { InterviewService } from '../lib/interview-service/service.ts';
import { exchangeInvitation, startCandidate } from '../lib/interview-service/candidate.ts';
import { RecordingStorage, recordingStorageConfig } from '../lib/interview-service/recording-storage.ts';
import { openRecording, issueChunk, confirmChunk, scheduleRecordingJobs, candidateChunkUpload } from '../lib/interview-service/recordings.ts';
import { runClaimedJob } from '../lib/interview-service/worker.ts';
const url=process.env.INTERVIEW_TEST_DATABASE_URL || process.env.INTERVIEW_DATABASE_URL;
if (!url && process.env.INTERVIEW_DATABASE_TEST_REQUIRED==='true') throw new Error('Existing Herd database required');

test('recording finalization on disposable Herd fixtures', {skip:!url}, async t => {
  const schema='recording_finalize_test_'+randomBytes(8).toString('hex'), admin=createServicePool(url);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool=createServicePool(url,schema); await migrateService(pool);
    const service=new InterviewService(pool,randomBytes(32),'https://interviewer.test');
    // In-memory S3 covering the calls finalization makes.
    const objects=new Map(); let failJoin=false;
    const client={send:async command=>{
      const name=command.constructor.name, input=command.input;
      if (name==='GetObjectCommand') { const bytes=objects.get(input.Key); return {Body:{transformToByteArray:async()=>bytes}}; }
      if (name==='CreateMultipartUploadCommand') { client.parts=[]; return {UploadId:'up'}; }
      if (name==='UploadPartCommand') { if (failJoin) throw new Error('S3 outage'); client.parts.push(input.Body); return {ETag:'e'+input.PartNumber}; }
      if (name==='CompleteMultipartUploadCommand') { objects.set(input.Key,Buffer.concat(client.parts)); return {}; }
      if (name==='AbortMultipartUploadCommand') return {};
      if (name==='DeleteObjectsCommand') { for (const o of input.Delete.Objects) objects.delete(o.Key); return {}; }
      if (name==='HeadObjectCommand') { if (!objects.has(input.Key)) throw Object.assign(new Error('NotFound'),{$metadata:{httpStatusCode:404}}); return {ContentLength:objects.get(input.Key).length}; }
      throw new Error(`unexpected ${name}`);
    }};
    const config=recordingStorageConfig({INTERVIEW_RECORDING_ENABLED:'true',INTERVIEW_RECORDING_S3_BUCKET:'recordings-test',INTERVIEW_RECORDING_S3_REGION:'ap-south-1'});
    const storage=new RecordingStorage(config,client);
    service.recording=storage;
    const account=await transaction(pool,db=>provisionAccount(db,'Finalize'));
    const p=await authenticate(pool,`Bearer ${account.token}`);
    const ws=await service.createWorkspace(p,{external_reference:newId('team'),display_name:'Finalize'},newId('cmd'));
    async function recording(sequences,{upload=sequences}={}){
      const now=Date.now(),last=new Date(now+120000).toISOString();
      const input={workspace_id:ws.id,external_reference:newId('external'),candidate:{external_id:'person',display_name:'Synthetic Candidate'},job:{external_id:'job',title:'Engineer',description:'Synthetic'},configuration:{mode:'adaptive',modality:'audio',language:'en',duration_limit_seconds:60,difficulty:'mid',follow_ups_enabled:true,interviewer_profile_id:'sandbox_default',rubric_version_id:'sandbox_v1'},availability:{kind:'window',opens_at:new Date(now-1000).toISOString(),last_start_at:last,must_finish_at:new Date(now+240000).toISOString(),display_timezone:'UTC'},authorization_budget:{external_reservation_id:newId('hold'),metric:'interview_seconds',max_quantity:60,start_before:last}};
      const row=await service.createInterview(p,input,newId('cmd'));
      const link=await service.accessLink(p,row.id,{expires_at:last},newId('cmd'));
      const session=await exchangeInvitation(service,new URL(link.url).hash.slice(1));
      await startCandidate(service,session.token);
      const attemptId=(await pool.query('SELECT attempt_id FROM service_interviews WHERE id=$1',[row.id])).rows[0].attempt_id;
      const rec=await transaction(pool,db=>openRecording(db,{accountId:p.accountId,interviewId:row.id,attemptId},'interviews/','video/webm','video_v1'));
      for (const sequence of sequences) {
        const chunk=await transaction(pool,db=>issueChunk(db,rec.id,sequence));
        if (upload.includes(sequence)) {
          objects.set(chunk.object_key,Buffer.from(`[${sequence}]`));
          await transaction(pool,db=>confirmChunk(db,rec.id,sequence,objects.get(chunk.object_key).length));
        }
      }
      return {rec,interviewId:row.id,attemptId,token:session.token};
    }
    const end=(attemptId,minutesAgo)=>pool.query(`UPDATE service_attempts SET ended_at=now()-($2*interval '1 minute') WHERE id=$1`,[attemptId,minutesAgo]);
    const job=async interviewId=>(await pool.query("SELECT * FROM service_jobs WHERE kind='recording' AND interview_id=$1",[interviewId])).rows[0];
    async function run(interviewId){
      const claimed=(await pool.query("UPDATE service_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '30 seconds' WHERE kind='recording' AND interview_id=$1 AND status='pending' RETURNING *",[interviewId,newId('lease')])).rows[0];
      assert.ok(claimed,'recording job queued');
      await runClaimedJob(service,claimed,async()=>{});
      return (await pool.query('SELECT * FROM service_recordings WHERE interview_id=$1',[interviewId])).rows[0];
    }

    await t.test('jobs are queued only after the upload window closes, once per recording',async()=>{
      const f=await recording([0,1]);
      await end(f.attemptId,2);
      await scheduleRecordingJobs(service);
      assert.equal(await job(f.interviewId),undefined);
      await end(f.attemptId,10);
      await scheduleRecordingJobs(service); await scheduleRecordingJobs(service);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM service_jobs WHERE kind='recording' AND interview_id=$1",[f.interviewId])).rows[0].n,1);
      // An attempt that never recorded an end closes at its deadline.
      const g=await recording([0]);
      await pool.query("UPDATE service_attempts SET deadline_at=now()-interval '10 minutes' WHERE id=$1",[g.attemptId]);
      await scheduleRecordingJobs(service);
      assert.ok(await job(g.interviewId));
    });

    await t.test('a complete recording joins in order, replaces its chunks and closes uploads',async()=>{
      const f=await recording([0,1,2]);
      await end(f.attemptId,10); await scheduleRecordingJobs(service);
      const row=await run(f.interviewId);
      assert.equal(row.status,'ready');
      assert.equal(row.object_key,`${f.rec.object_prefix}recording.webm`);
      assert.equal(objects.get(row.object_key).toString(),'[0][1][2]');
      assert.equal(Number(row.object_bytes),9);
      assert.ok(row.ended_at);
      assert.deepEqual([...objects.keys()].filter(k=>k.startsWith(f.rec.object_prefix)),[row.object_key]);
      assert.equal((await job(f.interviewId)).status,'done');
      // Chunk rows remain as evidence; new uploads are refused.
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM service_recording_chunks WHERE recording_id=$1',[f.rec.id])).rows[0].n,3);
      await assert.rejects(transaction(pool,db=>issueChunk(db,f.rec.id,3)),e=>e.code==='recording_closed');
      await assert.rejects(candidateChunkUpload(service,f.token,{sequence:3}),e=>e.code==='recording_closed');
    });

    await t.test('gaps and lost final chunks produce a playable but incomplete recording',async()=>{
      const gap=await recording([0,1,2],{upload:[0,2]});
      await end(gap.attemptId,10); await scheduleRecordingJobs(service);
      const gapRow=await run(gap.interviewId);
      assert.equal(gapRow.status,'incomplete');
      assert.equal(objects.get(gapRow.object_key).toString(),'[0][2]');
      const tail=await recording([0,1,2],{upload:[0,1]});
      await end(tail.attemptId,10); await scheduleRecordingJobs(service);
      assert.equal((await run(tail.interviewId)).status,'incomplete');
    });

    await t.test('without the first chunk or any chunk the recording fails and keeps its chunks',async()=>{
      const headless=await recording([0,1],{upload:[1]});
      await end(headless.attemptId,10); await scheduleRecordingJobs(service);
      const row=await run(headless.interviewId);
      assert.equal(row.status,'failed'); assert.equal(row.object_key,null);
      assert.ok(objects.has(`${headless.rec.object_prefix}chunks/00001.webm`));
      const empty=await recording([]);
      await end(empty.attemptId,10); await scheduleRecordingJobs(service);
      assert.equal((await run(empty.interviewId)).status,'failed');
    });

    await t.test('S3 failure retries the job and a later run completes',async()=>{
      const f=await recording([0,1]);
      await end(f.attemptId,10); await scheduleRecordingJobs(service);
      failJoin=true;
      try { assert.equal((await run(f.interviewId)).status,'finalizing'); } finally { failJoin=false; }
      const retry=await job(f.interviewId);
      assert.equal(retry.status,'pending'); assert.equal(retry.last_error,'job_failed');
      await pool.query("UPDATE service_jobs SET available_at=now() WHERE id=$1",[retry.id]);
      assert.equal((await run(f.interviewId)).status,'ready');
      assert.equal(objects.get(`${f.rec.object_prefix}recording.webm`).toString(),'[0][1]');
    });

    await t.test('deleted interviews are not joined',async()=>{
      const f=await recording([0]);
      await end(f.attemptId,10); await scheduleRecordingJobs(service);
      await pool.query('UPDATE service_interviews SET deletion_requested_at=now() WHERE id=$1',[f.interviewId]);
      const row=await run(f.interviewId);
      assert.equal(row.status,'recording'); assert.equal(row.object_key,null);
      assert.equal((await job(f.interviewId)).status,'done');
    });

    await t.test('a missing storage configuration leaves the job to retry',async()=>{
      const f=await recording([0]);
      await end(f.attemptId,10); await scheduleRecordingJobs(service);
      service.recording=undefined;
      try { assert.equal((await run(f.interviewId)).status,'recording'); } finally { service.recording=storage; }
      assert.equal((await job(f.interviewId)).status,'pending');
    });
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
