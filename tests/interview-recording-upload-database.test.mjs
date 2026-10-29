import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { createServicePool, migrateService, transaction } from '../lib/interview-service/postgres.ts';
import { provisionAccount, authenticate, newId } from '../lib/interview-service/security.ts';
import { InterviewService } from '../lib/interview-service/service.ts';
import { exchangeInvitation, startCandidate, candidateStatus } from '../lib/interview-service/candidate.ts';
import { RecordingStorage, recordingStorageConfig } from '../lib/interview-service/recording-storage.ts';
import { startCandidateRecording, candidateChunkUpload, confirmCandidateChunk } from '../lib/interview-service/recordings.ts';
import { handleCandidate } from '../lib/interview-service/http.ts';
const url=process.env.INTERVIEW_TEST_DATABASE_URL || process.env.INTERVIEW_DATABASE_URL;
if (!url && process.env.INTERVIEW_DATABASE_TEST_REQUIRED==='true') throw new Error('Existing Herd database required');

test('candidate recording uploads on disposable Herd fixtures', {skip:!url}, async t => {
  const schema='recording_upload_test_'+randomBytes(8).toString('hex'), admin=createServicePool(url);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); pool=createServicePool(url,schema); await migrateService(pool);
    const service=new InterviewService(pool,randomBytes(32),'https://interviewer.test');
    // Offline S3: presigning is local, and HEAD answers from this map of "uploaded" objects.
    const uploaded=new Map();
    const client=new S3Client({region:'ap-south-1',credentials:{accessKeyId:'AKIAOFFLINETEST',secretAccessKey:'offline-secret'}});
    client.send=async command=>{
      if (command.constructor.name!=='HeadObjectCommand') throw new Error('unexpected S3 call');
      if (!uploaded.has(command.input.Key)) throw Object.assign(new Error('NotFound'),{$metadata:{httpStatusCode:404}});
      return {ContentLength:uploaded.get(command.input.Key)};
    };
    const recording=new RecordingStorage(recordingStorageConfig({INTERVIEW_RECORDING_ENABLED:'true',INTERVIEW_RECORDING_S3_BUCKET:'recordings-test',INTERVIEW_RECORDING_S3_REGION:'ap-south-1'}),client);
    service.recording=recording;
    async function client_(name){
      const account=await transaction(pool,db=>provisionAccount(db,name));
      const p=await authenticate(pool,`Bearer ${account.token}`);
      const ws=await service.createWorkspace(p,{external_reference:newId('team'),display_name:name},newId('cmd'));
      return {p,ws};
    }
    async function candidate({p,ws},start=true){
      const now=Date.now(),last=new Date(now+120000).toISOString();
      const input={workspace_id:ws.id,external_reference:newId('external'),candidate:{external_id:'person',display_name:'Synthetic Candidate'},job:{external_id:'job',title:'Engineer',description:'Synthetic'},configuration:{mode:'adaptive',modality:'audio',language:'en',duration_limit_seconds:60,difficulty:'mid',follow_ups_enabled:true,interviewer_profile_id:'sandbox_default',rubric_version_id:'sandbox_v1'},availability:{kind:'window',opens_at:new Date(now-1000).toISOString(),last_start_at:last,must_finish_at:new Date(now+240000).toISOString(),display_timezone:'UTC'},authorization_budget:{external_reservation_id:newId('hold'),metric:'interview_seconds',max_quantity:60,start_before:last}};
      const row=await service.createInterview(p,input,newId('cmd'));
      const link=await service.accessLink(p,row.id,{expires_at:last},newId('cmd'));
      const session=await exchangeInvitation(service,new URL(link.url).hash.slice(1));
      if(start)await startCandidate(service,session.token);
      const attemptId=(await pool.query('SELECT attempt_id FROM service_interviews WHERE id=$1',[row.id])).rows[0].attempt_id;
      return {p,interviewId:row.id,attemptId,token:session.token};
    }
    const consent={type:'video/webm;codecs=vp8,opus',consent_version:'video_v1'};
    const status=(code,s)=>e=>e.status===s&&e.code===code;
    const a=await client_('Upload A'), b=await client_('Upload B');

    await t.test('uploads refuse while recording is not configured',async()=>{
      const c=await candidate(a); service.recording=undefined;
      try {
        await assert.rejects(startCandidateRecording(service,c.token,consent),status('recording_disabled',409));
        await assert.rejects(candidateChunkUpload(service,c.token,{sequence:0}),status('recording_disabled',409));
      } finally { service.recording=recording; }
    });

    await t.test('every call requires a valid candidate session for a started interview',async()=>{
      for (const token of [null,'candidate_'+'x'.repeat(43),'not-a-token']) {
        await assert.rejects(startCandidateRecording(service,token,consent),status('invalid_session',401));
        await assert.rejects(candidateChunkUpload(service,token,{sequence:0}),status('invalid_session',401));
        await assert.rejects(confirmCandidateChunk(service,token,{sequence:0}),status('invalid_session',401));
      }
      const notStarted=await candidate(a,false);
      await assert.rejects(startCandidateRecording(service,notStarted.token,consent),status('not_started',409));
      const noRecording=await candidate(a);
      await assert.rejects(candidateChunkUpload(service,noRecording.token,{sequence:0}),status('recording_not_started',409));
    });

    await t.test('start validates consent, type and shape, and is repeatable',async()=>{
      const c=await candidate(a);
      await assert.rejects(startCandidateRecording(service,c.token,{...consent,consent_version:'transcript_v1'}),status('recording_consent_required',422));
      await assert.rejects(startCandidateRecording(service,c.token,{type:'video/webm'}),status('recording_consent_required',422));
      await assert.rejects(startCandidateRecording(service,c.token,{...consent,type:'image/png'}),status('unsupported_recording_type',415));
      await assert.rejects(startCandidateRecording(service,c.token,{...consent,extra:1}),status('validation_failed',422));
      await assert.rejects(startCandidateRecording(service,c.token,[]),status('validation_failed',422));
      const started=await startCandidateRecording(service,c.token,consent);
      assert.deepEqual(started,{status:'recording',content_type:'video/webm',max_chunk_bytes:8*1024*1024,max_sequence:60});
      assert.deepEqual(await startCandidateRecording(service,c.token,consent),started);
      await assert.rejects(startCandidateRecording(service,c.token,{...consent,type:'video/mp4'}),status('recording_type_changed',409));
    });

    await t.test('upload links are pinned to the candidate own attempt and bounded',async()=>{
      const c=await candidate(a); await startCandidateRecording(service,c.token,consent);
      const issued=await candidateChunkUpload(service,c.token,{sequence:3});
      assert.equal(issued.sequence,3);
      assert.equal(issued.upload.fields.key,`interviews/${c.p.accountId}/${c.interviewId}/${c.attemptId}/chunks/00003.webm`);
      assert.equal(issued.upload.fields['Content-Type'],'video/webm');
      for (const bad of [{sequence:61},{sequence:-1},{sequence:1.5},{sequence:'1'},{},{sequence:1,key:'x'},null])
        await assert.rejects(candidateChunkUpload(service,c.token,bad),status('validation_failed',422));
    });

    await t.test('confirmation trusts S3 size, is idempotent, and is isolated between candidates',async()=>{
      const c=await candidate(a), other=await candidate(b);
      await startCandidateRecording(service,c.token,consent); await startCandidateRecording(service,other.token,consent);
      const issued=await candidateChunkUpload(service,c.token,{sequence:0});
      await assert.rejects(confirmCandidateChunk(service,c.token,{sequence:0}),status('chunk_not_uploaded',409));
      await assert.rejects(confirmCandidateChunk(service,c.token,{sequence:1}),status('chunk_not_issued',404));
      uploaded.set(issued.upload.fields.key,4321);
      // Another candidate cannot confirm or reach this chunk through their own session.
      await assert.rejects(confirmCandidateChunk(service,other.token,{sequence:0}),status('chunk_not_issued',404));
      const otherIssued=await candidateChunkUpload(service,other.token,{sequence:0});
      assert.notEqual(otherIssued.upload.fields.key,issued.upload.fields.key);
      assert.deepEqual(await confirmCandidateChunk(service,c.token,{sequence:0}),{sequence:0,bytes:4321});
      assert.deepEqual(await confirmCandidateChunk(service,c.token,{sequence:0}),{sequence:0,bytes:4321});
      await assert.rejects(candidateChunkUpload(service,c.token,{sequence:0}),status('chunk_already_uploaded',409));
      const stored=(await pool.query('SELECT bytes FROM service_recording_chunks c JOIN service_recordings r ON r.id=c.recording_id WHERE r.attempt_id=$1',[c.attemptId])).rows;
      assert.deepEqual(stored.map(r=>Number(r.bytes)),[4321]);
    });

    await t.test('uploads close after the attempt ends plus the grace period',async()=>{
      const c=await candidate(a); await startCandidateRecording(service,c.token,consent);
      await pool.query("UPDATE service_attempts SET ended_at=now()-interval '1 minute' WHERE id=$1",[c.attemptId]);
      await pool.query("UPDATE service_interviews SET execution_status='completed' WHERE id=$1",[c.interviewId]);
      // The final chunk can still arrive shortly after the interview ends, but recording cannot start again.
      const late=await candidateChunkUpload(service,c.token,{sequence:9});
      assert.equal(late.sequence,9);
      await assert.rejects(startCandidateRecording(service,c.token,consent),status('recording_closed',409));
      await pool.query("UPDATE service_attempts SET ended_at=now()-interval '6 minutes' WHERE id=$1",[c.attemptId]);
      await assert.rejects(candidateChunkUpload(service,c.token,{sequence:10}),status('recording_closed',409));
      await assert.rejects(confirmCandidateChunk(service,c.token,{sequence:9}),status('recording_closed',409));
    });

    await t.test('deleted interviews and revoked sessions lose access',async()=>{
      const c=await candidate(a); await startCandidateRecording(service,c.token,consent);
      await pool.query('UPDATE service_candidate_sessions SET revoked_at=now() WHERE interview_id=$1',[c.interviewId]);
      await assert.rejects(candidateChunkUpload(service,c.token,{sequence:0}),status('invalid_session',401));
      const d=await candidate(a); await startCandidateRecording(service,d.token,consent);
      await pool.query('UPDATE service_interviews SET deletion_requested_at=now() WHERE id=$1',[d.interviewId]);
      await assert.rejects(candidateChunkUpload(service,d.token,{sequence:0}),status('invalid_session',401));
    });

    await t.test('the session says whether the camera is required',async()=>{
      const c=await candidate(a,false);
      // Synthetic interviews never record; live ones require it whenever storage is configured.
      assert.equal((await candidateStatus(service,c.token)).recording_required,false);
      await pool.query("UPDATE service_interviews SET execution_provider='openai_live' WHERE id=$1",[c.interviewId]);
      assert.equal((await candidateStatus(service,c.token)).recording_required,true);
      service.recording=undefined;
      try { assert.equal((await candidateStatus(service,c.token)).recording_required,false); }
      finally { service.recording=recording; }
    });

    await t.test('HTTP routes enforce origin, JSON and the session cookie',async()=>{
      const c=await candidate(a);
      const post=(path,payload,headers={})=>handleCandidate(new Request(`https://interviewer.test${path}`,{method:'POST',
        headers:{origin:'https://interviewer.test','content-type':'application/json',cookie:`__Host-interview_session=${c.token}`,...headers},
        body:JSON.stringify(payload)}),service);
      assert.equal((await post('/candidate/recording/start',consent,{origin:'https://evil.test'})).status,403);
      assert.equal((await post('/candidate/recording/start',consent,{'content-type':'text/plain'})).status,415);
      assert.equal((await post('/candidate/recording/start',consent,{cookie:''})).status,401);
      const started=await post('/candidate/recording/start',consent);
      assert.equal(started.status,200); assert.equal(started.headers.get('cache-control'),'no-store');
      const issued=await post('/candidate/recording/chunks',{sequence:0});
      assert.equal(issued.status,200);
      const {upload}=await issued.json();
      uploaded.set(upload.fields.key,99);
      const confirmed=await post('/candidate/recording/chunks/confirm',{sequence:0});
      assert.deepEqual(await confirmed.json(),{sequence:0,bytes:99});
      assert.equal((await post('/candidate/recording/nope',{})).status,404);
    });
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
