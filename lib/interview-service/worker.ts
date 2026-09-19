import { deleteInterviewData } from "./deletion.ts";
import { transaction } from "./postgres.ts";
import { newId, unseal } from "./security.ts";
import { emitEvent, recordShadowUsage, type InterviewRow, type InterviewService } from "./service.ts";
import { initialObservationState, applyObservation, type ObservationState } from "./provider.ts";
import { SandboxExecutionProvider } from "./providers/sandbox.ts";
import { validate } from "./validation.ts";
import { signWebhook } from "./webhook-signature.ts";
import type { WebhookTransport } from "./delivery.ts";

import { claimJob, ownsLease, finishJob, type Job } from "./job-leases.ts";
import { executeLive, assessLive } from "./live-worker.ts";
export { claimJob } from "./job-leases.ts";
export type { Job } from "./job-leases.ts";

async function execute(service: InterviewService,job: Job) {
  const attempt = (await service.pool.query("SELECT * FROM service_attempts WHERE interview_id=$1",[job.interview_id])).rows[0];
  if (!attempt) throw new Error("Missing attempt");
  if (attempt.provider !== "fake") return executeLive(service,job);
  const provider = new SandboxExecutionProvider();
  for await (const event of provider.observe({providerReference:attempt.provider_reference})) {
    const keepGoing = await transaction(service.pool,async db => {
      if (!await ownsLease(db,job)) return false;
      const interview = (await db.query<InterviewRow>("SELECT * FROM service_interviews WHERE id=$1 FOR UPDATE",[job.interview_id])).rows[0];
      if (interview.execution_status !== "in_progress") { await finishJob(db,job); return false; }
      const current = (await db.query("SELECT observations FROM service_attempts WHERE id=$1 FOR UPDATE",[attempt.id])).rows[0];
      const state = applyObservation(current.observations.usageStatus ? current.observations as ObservationState : initialObservationState(),event);
      const transcript = state.fragments.map(f => ({id:f.id,speaker:f.speaker,text:f.text,start_ms:f.startMs,end_ms:f.endMs}));
      await db.query("UPDATE service_attempts SET observations=$2,transcript=$3 WHERE id=$1",[attempt.id,state,JSON.stringify(transcript)]);
      return true;
    });
    if (!keepGoing) return;
  }
  await transaction(service.pool,async db => {
    if (!await ownsLease(db,job)) return;
    const row = (await db.query<InterviewRow>("SELECT * FROM service_interviews WHERE id=$1 FOR UPDATE",[job.interview_id])).rows[0];
    if (row.execution_status !== "in_progress") { await finishJob(db,job); return; }
    const state = (await db.query("SELECT observations FROM service_attempts WHERE id=$1",[attempt.id])).rows[0].observations as ObservationState;
    if (state.usageStatus !== "final") throw new Error("No authoritative final usage");
    const measured = Math.ceil(state.cumulativeAudioMs/1000);
    const updated = (await db.query<InterviewRow>(`UPDATE service_interviews SET execution_status=$2,usage_status='settled',resource_version=resource_version+1,
      updated_at=now() WHERE id=$1 RETURNING *`,[row.id,state.outcome])).rows[0];
    await db.query("UPDATE service_reservations SET status='settled' WHERE attempt_id=$1",[attempt.id]);
    await db.query("UPDATE service_attempts SET ended_at=now() WHERE id=$1",[attempt.id]);
    await emitEvent(db,updated,`interview.${state.outcome}`);
    await recordShadowUsage(db,updated,attempt.id,measured);
    await db.query("INSERT INTO service_jobs(id,kind,dedupe_key,interview_id) VALUES ($1,'assess',$2,$3) ON CONFLICT (dedupe_key) DO NOTHING",[newId("job"),`assess:${attempt.id}`,row.id]);
    await finishJob(db,job);
  });
}
async function assess(service: InterviewService,job: Job) {
  const mode = (await service.pool.query("SELECT execution_provider FROM service_interviews WHERE id=$1", [job.interview_id])).rows[0];
  if (mode?.execution_provider !== "fake") return assessLive(service,job);
  await transaction(service.pool,async db => {
    if (!await ownsLease(db,job)) return;
    const row = (await db.query<InterviewRow>("SELECT * FROM service_interviews WHERE id=$1 FOR UPDATE",[job.interview_id])).rows[0];
    const attempt = (await db.query("SELECT * FROM service_attempts WHERE id=$1",[row.attempt_id])).rows[0];
    if (row.deletion_requested_at || attempt.result || row.execution_status === "cancelled") { await finishJob(db,job); return; }
    const result = { schema_version:"1.0",interview_id:row.id,workspace_id:row.workspace_id,attempt_id:row.attempt_id,revision:1,
      status:"insufficient_evidence",rubric_version_id:row.request.configuration.rubric_version_id,
      summary:"Synthetic sandbox interview. No candidate assessment was performed.",score_scale:{min:0,max:100},overall_score:null,
      competencies:[],transcript:attempt.transcript,coverage_limits:["Synthetic test data; not suitable for hiring decisions."] };
    validate("Result",result);
    await db.query("UPDATE service_attempts SET result=$2 WHERE id=$1",[attempt.id,result]);
    const updated = (await db.query<InterviewRow>(`UPDATE service_interviews SET assessment_status='insufficient_evidence',resource_version=resource_version+1,updated_at=now() WHERE id=$1 RETURNING *`,[row.id])).rows[0];
    await emitEvent(db,updated,"result.ready",{interview_id:row.id,attempt_id:attempt.id,external_reference:row.external_reference,result_revision:1,assessment_status:"insufficient_evidence"});
    await finishJob(db,job);
  });
}
async function deliver(service: InterviewService,job: Job,transport: WebhookTransport) {
  const record = (await service.pool.query(`SELECT e.body,e.id,w.url,w.secret_ciphertext,w.status FROM service_events e
    JOIN service_webhook_endpoints w ON w.id=$2 AND w.account_id=e.account_id WHERE e.id=$1`,[job.event_id,job.endpoint_id])).rows[0];
  if (!record) return;
  const valid = await transaction(service.pool,db => ownsLease(db,job));
  if (!valid) return;
  if (record.status === "active") {
    const secret = unseal(record.secret_ciphertext,service.key);
    await transport(record.url,record.body,signWebhook(record.body,record.id,Math.floor(Date.now()/1000),secret));
  }
  await transaction(service.pool,async db => { if (await ownsLease(db,job)) await finishJob(db,job); });
}
/** Lease fencing prevents a recovered worker from committing stale execution/assessment work. */
export async function runClaimedJob(service: InterviewService,job: Job,transport: WebhookTransport) {
  try {
    if (job.kind === "delete") await deleteInterviewData(service,job);
    else if (job.kind === "execute") await execute(service,job);
    else if (job.kind === "assess") await assess(service,job);
    else if (job.kind === "deliver") await deliver(service,job,transport);
    else throw new Error("Unknown job");
  } catch {
    if (job.kind === "assess" && job.attempts >= 3) {
      await transaction(service.pool,async db => {
        if (!await ownsLease(db,job)) return;
        const updated = (await db.query<InterviewRow>("UPDATE service_interviews SET assessment_status='failed',resource_version=resource_version+1,updated_at=now() WHERE id=$1 AND assessment_status NOT IN ('ready','insufficient_evidence','not_requested') RETURNING *",[job.interview_id])).rows[0];
        if (updated) await emitEvent(db,updated,"result.failed");
        await db.query("UPDATE service_jobs SET status='dead',lease_token=NULL,lease_until=NULL,last_error='assessment_failed' WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token]);
      });
      return;
    }
    // Persist only an operational code: exceptions can contain PII, keys or destination URLs.
    await service.pool.query(`UPDATE service_jobs SET status=CASE WHEN attempts>=6 AND kind<>'delete' THEN 'dead' ELSE 'pending' END,
      available_at=now()+($3*interval '1 second'),lease_token=NULL,lease_until=NULL,last_error='job_failed'
      WHERE id=$1 AND lease_token=$2 AND lease_until>now()`,[job.id,job.lease_token,Math.min(300,2**job.attempts)+Math.floor(Math.random()*3)]);
  }
}
export async function expireInvitations(service: InterviewService) {
  return transaction(service.pool,async db => {
    const rows = await db.query<InterviewRow>(`SELECT * FROM service_interviews WHERE execution_status='ready'
      AND (request->'availability'->>'last_start_at')::timestamptz<=now() ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`);
    for (const row of rows.rows) {
      const updated = (await db.query<InterviewRow>("UPDATE service_interviews SET execution_status='expired',usage_status='settled',resource_version=resource_version+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];
      await db.query("UPDATE service_access_links SET revoked_at=now() WHERE interview_id=$1",[row.id]);
      await db.query("UPDATE service_candidate_sessions SET revoked_at=now() WHERE interview_id=$1",[row.id]);
      await emitEvent(db,updated,"interview.expired");
    }
    return rows.rowCount ?? 0;
  });
}
export async function runWorkerOnce(service: InterviewService,transport: WebhookTransport) {
  await expireInvitations(service);
  const job = await claimJob(service);
  if (!job) return false;
  await runClaimedJob(service,job,transport);
  return true;
}
