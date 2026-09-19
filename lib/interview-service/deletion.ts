import type { PoolClient } from "pg";
import { transaction } from "./postgres.ts";
import { hashToken, newId, requireScope, seal, unseal, ServiceError, type Principal } from "./security.ts";
import { emitEvent, type InterviewRow, type InterviewService } from "./service.ts";
import { finishJob, ownsLease, type Job } from "./job-leases.ts";

function view(row: InterviewRow) {
  return { interview_id: row.id, workspace_id: row.workspace_id,
    status: row.deleted_at ? "deleted" : "deletion_pending",
    ...(row.deletion_blocker ? { blocker: row.deletion_blocker } : {}) };
}
export async function deletionStatus(service: InterviewService, p: Principal, id: string) {
  requireScope(p,"interviews:read");
  const row = await service.getInterview(service.pool,p,id,false,true);
  if (!row.deletion_requested_at) throw new ServiceError(409,"deletion_not_requested");
  return view(row);
}

/** Remove replayable secrets as well as primary data. Legacy commands predate interview_id. */
async function eraseCommands(db: PoolClient, service: InterviewService, row: InterviewRow) {
  const commands = await db.query("SELECT * FROM service_commands WHERE account_id=$1 AND erased_at IS NULL AND operation LIKE 'interview.%' AND operation NOT LIKE 'interview.delete:%'",[row.account_id]);
  for (const command of commands.rows) {
    const response = JSON.parse(unseal(command.response_ciphertext,service.key));
    if (command.interview_id !== row.id && response.id !== row.id && response.interview_id !== row.id && !command.operation.endsWith(`:${row.id}`)) continue;
    await db.query("UPDATE service_commands SET interview_id=$4,response_ciphertext=$5,request_hash='',erased_at=now() WHERE account_id=$1 AND operation=$2 AND command_key=$3",
      [row.account_id,command.operation,command.command_key,row.id,seal("{}",service.key)]);
  }
}
async function eraseCopies(db: PoolClient, row: InterviewRow) {
  await db.query("DELETE FROM service_candidate_sessions WHERE interview_id=$1",[row.id]);
  await db.query("DELETE FROM service_access_links WHERE interview_id=$1",[row.id]);
  await db.query("DELETE FROM service_observations WHERE attempt_id=$1",[row.attempt_id]);
  await db.query(`UPDATE service_attempts SET transcript='[]',result=NULL,offer_ciphertext=NULL,answer_ciphertext=NULL,
    offer_hash=NULL,consent_version=NULL,consent_at=NULL,
    deletion_measured_audio_ms=coalesce((observations->>'cumulativeAudioMs')::bigint,deletion_measured_audio_ms,0),
    deletion_usage_final=coalesce(observations->>'usageStatus'='final',deletion_usage_final,false),
    observations=jsonb_build_object('usageStatus',coalesce(observations->>'usageStatus','provisional'),
      'cumulativeAudioMs',coalesce((observations->>'cumulativeAudioMs')::bigint,0),
      'captureIncomplete',true,'events','{}'::jsonb,'fragments','[]'::jsonb)
    WHERE interview_id=$1`,[row.id]);
  // Events can carry caller-supplied references; drop their jobs before the event rows.
  await db.query("DELETE FROM service_jobs WHERE event_id IN (SELECT id FROM service_events WHERE interview_id=$1 AND type<>'interview.deleted')",[row.id]);
  await db.query("DELETE FROM service_events WHERE interview_id=$1 AND type<>'interview.deleted'",[row.id]);
  await db.query("UPDATE service_usage SET record=record-'external_reference'-'external_reservation_id' WHERE attempt_id=$1",[row.attempt_id]);
}
export async function requestDeletion(service: InterviewService, p: Principal, id: string, key: string | null) {
  requireScope(p,"interviews:write");
  const owner = await service.getInterview(service.pool,p,id,false,true);
  return service.command(p,`interview.delete:${id}`,key,{},owner.workspace_id,async db => {
    const row = await service.getInterview(db,p,id,true,true);
    if (!row.deletion_requested_at) {
      await db.query(`UPDATE service_interviews SET deletion_requested_at=now(),external_reference_hash=$2,
        external_reference=id,request='{}',execution_status='cancelled',assessment_status='not_requested',
        usage_status=CASE WHEN attempt_id IS NULL THEN 'settled' ELSE usage_status END,
        resource_version=resource_version+1,updated_at=now() WHERE id=$1`,[id,hashToken(row.external_reference)]);
      await db.query("UPDATE service_attempts SET stop_requested_at=coalesce(stop_requested_at,now()),stop_reason='data_deletion' WHERE interview_id=$1",[id]);
      await db.query("UPDATE service_jobs SET status='done',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE interview_id=$1 AND kind='assess'",[id]);
      await eraseCommands(db,service,row);
      await eraseCopies(db,row);
      await db.query("INSERT INTO service_jobs(id,kind,dedupe_key,interview_id) VALUES ($1,'delete',$2,$3) ON CONFLICT (dedupe_key) DO NOTHING",[newId("job"),`delete:${id}`,id]);
    }
    // DELETE acknowledges acceptance. Poll the separate status resource for completion.
    return { interview_id:id, workspace_id:row.workspace_id,status:"deletion_pending" };
  });
}

/** Retry indefinitely at bounded intervals; unknown remote creation is never labeled purged. */
export async function deleteInterviewData(service: InterviewService, job: Job) {
  const snapshot = await transaction(service.pool,async db => {
    if (!await ownsLease(db,job)) return null;
    const row = (await db.query<InterviewRow>("SELECT * FROM service_interviews WHERE id=$1",[job.interview_id])).rows[0];
    if (!row?.deletion_requested_at || row.deleted_at) { await finishJob(db,job); return null; }
    const attempt = (await db.query("SELECT * FROM service_attempts WHERE interview_id=$1",[row.id])).rows[0];
    const running = (await db.query("SELECT id FROM service_jobs WHERE interview_id=$1 AND kind='execute' AND status='running' AND lease_until>now()",[row.id])).rowCount;
    return { row,attempt,running };
  });
  if (!snapshot) return;
  const { row,attempt,running } = snapshot;
  let blocker: string | null = null;
  if (running) blocker = "execution_stopping";
  else if (attempt && attempt.provider !== "fake" && attempt.connection_state !== "closed") {
    if (attempt.connection_state === "creating" || (attempt.connection_state === "uncertain" && attempt.provider_reference.startsWith("pending_"))) {
      blocker = "provider_outcome_unknown";
    } else if (attempt.connection_state !== "queued") {
      if (!service.live?.provider) blocker = "provider_unavailable";
      else {
        try { await service.live.provider.hangup(attempt.provider_reference); }
        catch { blocker = "provider_stop_failed"; }
      }
    }
  }
  await transaction(service.pool,async db => {
    if (!await ownsLease(db,job)) return;
    await eraseCopies(db,row);
    if (blocker) {
      await db.query("UPDATE service_interviews SET deletion_blocker=$2 WHERE id=$1",[row.id,blocker]);
      await db.query("UPDATE service_jobs SET status='pending',lease_token=NULL,lease_until=NULL,available_at=now()+interval '30 seconds',last_error=$3 WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token,blocker]);
      return;
    }
    await db.query("UPDATE service_jobs SET status='done',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE interview_id=$1 AND kind IN ('execute','assess')",[row.id]);
    await db.query("UPDATE service_attempts SET provider_reference=id,connection_state='closed',ended_at=coalesce(ended_at,now()),observations='{}',stop_reason=NULL,observer_ready_at=NULL WHERE interview_id=$1",[row.id]);
    // Unknown usage is not invented or released. A held numeric reservation remains for reconciliation.
    if (!attempt || attempt.connection_state === "queued" || attempt.provider === "fake") {
      await db.query("UPDATE service_reservations SET status='released' WHERE interview_id=$1 AND status='reserved'",[row.id]);
    }
    const updated = (await db.query<InterviewRow>("UPDATE service_interviews SET deleted_at=now(),deletion_blocker=NULL,resource_version=resource_version+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];
    await emitEvent(db,updated,"interview.deleted");
    await finishJob(db,job);
  });
}
