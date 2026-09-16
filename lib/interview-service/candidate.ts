import type { PoolClient } from "pg";
import { hashToken, newId, newToken, ServiceError } from "./security.ts";
import { transaction } from "./postgres.ts";
import { emitEvent, type InterviewRow, type InterviewService } from "./service.ts";

export async function exchangeInvitation(service: InterviewService, token: unknown) {
  if (typeof token !== "string" || !/^invite_[A-Za-z0-9_-]{43}$/.test(token)) throw new ServiceError(401,"invalid_invitation");
  return transaction(service.pool, async db => {
    const hint = (await db.query("SELECT interview_id FROM service_access_links WHERE token_hash=$1",[hashToken(token)])).rows[0];
    if (!hint) throw new ServiceError(401,"invalid_invitation");
    // All candidate mutations lock the interview first, then its tokens.
    const row = (await db.query<InterviewRow>("SELECT * FROM service_interviews WHERE id=$1 FOR UPDATE",[hint.interview_id])).rows[0];
    const link = (await db.query(`SELECT * FROM service_access_links WHERE token_hash=$1 AND revoked_at IS NULL
      AND claimed_at IS NULL AND expires_at>now() FOR UPDATE`,[hashToken(token)])).rows[0];
    const account = (await db.query("SELECT id FROM service_accounts WHERE id=$1 AND disabled_at IS NULL",[row.account_id])).rows[0];
    if (!link || !account || row.execution_status !== "ready" || Date.parse(row.request.availability.last_start_at) <= Date.now()) throw new ServiceError(401,"invalid_invitation");
    const session = newToken("candidate");
    await db.query("UPDATE service_access_links SET claimed_at=now() WHERE id=$1",[link.id]);
    await db.query("INSERT INTO service_candidate_sessions(id,interview_id,link_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)",
      [newId("cs"),row.id,link.id,hashToken(session),row.request.availability.must_finish_at]);
    return { token: session, expiresAt: row.request.availability.must_finish_at };
  });
}
async function candidateRow(db: PoolClient, token: string | null, lock: boolean) {
  if (!token || !/^candidate_[A-Za-z0-9_-]{43}$/.test(token)) throw new ServiceError(401,"invalid_session");
  const found = await db.query<InterviewRow>(`SELECT i.* FROM service_interviews i
    JOIN service_candidate_sessions s ON s.interview_id=i.id
    JOIN service_access_links l ON l.id=s.link_id JOIN service_accounts a ON a.id=i.account_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND l.revoked_at IS NULL AND a.disabled_at IS NULL
    ${lock ? "FOR UPDATE OF i" : ""}`, [hashToken(token)]);
  if (!found.rowCount) throw new ServiceError(401,"invalid_session");
  // Under READ COMMITTED, recheck revocation after waiting for the interview lock.
  const valid = await db.query(`SELECT s.id FROM service_candidate_sessions s JOIN service_access_links l ON l.id=s.link_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND l.revoked_at IS NULL AND s.expires_at>now()`,[hashToken(token)]);
  if (!valid.rowCount) throw new ServiceError(401,"invalid_session");
  return found.rows[0];
}
function candidateView(row: InterviewRow) {
  return { interview_id: row.id, execution_status: row.execution_status, attempt_id: row.attempt_id,
    job_title: row.request.job.title, duration_limit_seconds: row.request.configuration.duration_limit_seconds,
    opens_at: row.request.availability.opens_at, last_start_at: row.request.availability.last_start_at,
    environment: "test", transport: "sandbox" };
}
export async function candidateStatus(service: InterviewService, token: string | null) {
  return transaction(service.pool, async db => candidateView(await candidateRow(db,token,false)));
}
export async function startCandidate(service: InterviewService, token: string | null) {
  return transaction(service.pool,async db => {
    const row = await candidateRow(db,token,true);
    // Repeated start/reconnect returns the original attempt, even after completion.
    if (row.attempt_id && ["in_progress","completed","interrupted","failed"].includes(row.execution_status)) return candidateView(row);
    if (row.execution_status !== "ready") throw new ServiceError(409,"invalid_state");
    const now = Date.now(), w = row.request.availability;
    if (now < Date.parse(w.opens_at)) throw new ServiceError(409,"interview_not_open");
    if (now >= Math.min(Date.parse(w.last_start_at),Date.parse(row.request.authorization_budget.start_before))) throw new ServiceError(410,"interview_expired");
    const seconds = row.request.configuration.duration_limit_seconds;
    if (now + seconds*1000 > Date.parse(w.must_finish_at)) throw new ServiceError(410,"interview_expired");
    const ws = (await db.query("SELECT * FROM service_workspaces WHERE id=$1 FOR UPDATE",[row.workspace_id])).rows[0];
    const reserved = (await db.query(`SELECT count(*)::integer AS active,coalesce(sum(reserved_seconds),0)::text AS seconds
      FROM service_reservations WHERE workspace_id=$1 AND status='reserved'`,[row.workspace_id])).rows[0];
    const used = (await db.query("SELECT coalesce(sum(measured_seconds),0)::text AS seconds FROM service_usage WHERE workspace_id=$1",[row.workspace_id])).rows[0];
    if (reserved.active >= ws.concurrency_limit) throw new ServiceError(409,"concurrency_limit");
    if (BigInt(reserved.seconds)+BigInt(used.seconds)+BigInt(seconds) > BigInt(ws.allowance_seconds)) throw new ServiceError(409,"quota_exceeded");
    const attempt = newId("att");
    await db.query("INSERT INTO service_attempts(id,interview_id,provider,provider_reference,deadline_at) VALUES ($1,$2,'fake',$3,$4)",
      [attempt,row.id,newId("fake"),new Date(now+seconds*1000)]);
    await db.query("INSERT INTO service_reservations(id,workspace_id,interview_id,attempt_id,reserved_seconds,status) VALUES ($1,$2,$3,$4,$5,'reserved')",[newId("res"),row.workspace_id,row.id,attempt,seconds]);
    const updated = (await db.query<InterviewRow>(`UPDATE service_interviews SET attempt_id=$2,execution_status='in_progress',assessment_status='pending',
      resource_version=resource_version+1,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,attempt])).rows[0];
    await db.query("INSERT INTO service_jobs(id,kind,dedupe_key,interview_id) VALUES ($1,'execute',$2,$3)",[newId("job"),`execute:${attempt}`,row.id]);
    await emitEvent(db,updated,"interview.started");
    return candidateView(updated);
  });
}
