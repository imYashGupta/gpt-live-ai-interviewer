import type { PoolClient } from "pg";
import { transaction } from "./postgres.ts";
import { newId } from "./security.ts";
import type { InterviewService } from "./service.ts";

export interface Job { id: string; kind: string; interview_id: string; event_id: string; endpoint_id: string; lease_token: string; attempts: number }
export async function claimJob(service: InterviewService, controlOnly = false): Promise<Job | null> {
  return transaction(service.pool,async db => {
    const row = (await db.query(`SELECT * FROM service_jobs WHERE ((status='pending' AND available_at<=now())
      OR (status='running' AND lease_until<now())) AND (NOT $1::boolean OR kind<>'execute') ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,[controlOnly])).rows[0];
    if (!row) return null;
    return (await db.query<Job>(`UPDATE service_jobs SET status='running',attempts=attempts+1,lease_token=$2,
      lease_until=now()+interval '30 seconds' WHERE id=$1 RETURNING *`,[row.id,newId("lease")])).rows[0];
  });
}
export async function ownsLease(db: PoolClient,job: Job): Promise<boolean> {
  // Match deletion's interview-before-job ordering, including stale execution/assessment callbacks.
  if (job.interview_id) await db.query("SELECT id FROM service_interviews WHERE id=$1 FOR UPDATE",[job.interview_id]);
  return Boolean((await db.query("SELECT id FROM service_jobs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",[job.id,job.lease_token])).rowCount);
}
export async function finishJob(db: PoolClient,job: Job) {
  await db.query("UPDATE service_jobs SET status='done',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token]);
}
