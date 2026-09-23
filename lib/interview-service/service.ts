import type { Pool, PoolClient } from "pg";
import type { LiveOptions } from "./live-provider.ts";
import { transaction } from "./postgres.ts";
import { authenticate, assertId, hashToken, newId, newToken, requireScope, seal, ServiceError, unseal, workspace, type Principal } from "./security.ts";
import { validate, type InterviewRequest } from "./validation.ts";
import { validateInterviewSemantics } from "./contract-rules.ts";
import { requestDeletion, deletionStatus } from "./deletion.ts";
import { webhookUrl } from "./delivery.ts";

export const capabilities = {
  schema_version: "1.0", modes: ["adaptive"], modalities: ["audio"], languages: ["en"],
  duration_min_seconds: 60, duration_max_seconds: 3600,
  interviewer_profile_ids: ["sandbox_default"], rubric_version_ids: ["sandbox_v1"],
};
export interface InterviewRow {
  id: string; account_id: string; workspace_id: string; external_reference: string;
  execution_provider: string; request: InterviewRequest; resource_version: number; execution_status: string;
  deletion_requested_at: Date | null; deleted_at: Date | null; deletion_blocker: string | null;
  assessment_status: string; usage_status: string; attempt_id: string | null; updated_at: Date;
}
export function interviewView(row: InterviewRow) {
  const { id, workspace_id, external_reference, resource_version, execution_status, assessment_status, usage_status, attempt_id } = row;
  return { id, workspace_id, external_reference, resource_version, execution_status, assessment_status, usage_status, attempt_id, updated_at: row.updated_at.toISOString() };
}
export async function emitEvent(db: PoolClient, row: InterviewRow, type: string, data?: unknown) {
  if (row.deletion_requested_at && type !== "interview.deleted") return;
  const id = newId("evt");
  const event = { id, type, schema_version: "1.0", occurred_at: new Date().toISOString(), account_id: row.account_id,
    workspace_id: row.workspace_id, subject: `interview/${row.id}`, resource_version: row.resource_version,
    data: data ?? { interview_id: row.id, attempt_id: row.attempt_id, external_reference: row.external_reference } };
  validate("Event", event);
  await db.query("INSERT INTO service_events(id,account_id,workspace_id,interview_id,type,body) VALUES ($1,$2,$3,$4,$5,$6)",
    [id,row.account_id,row.workspace_id,row.id,type,JSON.stringify(event)]);
  // Registry verification is an operator action. Unverified destinations never receive data.
  const endpoints = await db.query("SELECT id FROM service_webhook_endpoints WHERE account_id=$1 AND status='active' AND $2=ANY(event_types)", [row.account_id,type]);
  for (const endpoint of endpoints.rows) {
    await db.query("INSERT INTO service_jobs(id,kind,dedupe_key,event_id,endpoint_id) VALUES ($1,'deliver',$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING",
      [newId("job"),`deliver:${id}:${endpoint.id}`,id,endpoint.id]);
  }
  return event;
}

/** Billing policy lives here because only the service observes the outcome: service-side failures bill nothing. */
export function billableSeconds(row: InterviewRow, outcome: string, measured: number, billed: boolean) {
  // Deletion erases the request, and the client discards usage for deleted interviews.
  if (!billed || row.deletion_requested_at || row.execution_provider === "fake" || !["completed","cancelled"].includes(outcome)) return 0;
  return Math.min(measured,row.request.configuration.duration_limit_seconds);
}
export async function recordShadowUsage(db: PoolClient,row: InterviewRow,attemptId: string,measured: number,billable = 0) {
  // Serialize per-workspace insert/commit order so a usage cursor cannot skip an earlier uncommitted settlement.
  await db.query("SELECT id FROM service_workspaces WHERE id=$1 FOR UPDATE",[row.workspace_id]);
  const settlement = { record_type:"settlement", settlement_id:newId("set"),interview_id:row.id,attempt_id:attemptId,
    workspace_id:row.workspace_id,external_reference:row.deletion_requested_at ? row.id : row.external_reference,external_reservation_id:row.deletion_requested_at ? row.id : row.request.authorization_budget.external_reservation_id,
    metric:"interview_seconds",measured_quantity:measured,billable_quantity:billable,credit_quantity:`${billable}.000000`,
    rate_card_version:row.execution_provider === "fake" ? "sandbox_zero_v1" : billable ? "seconds_v1" : "pilot_zero_v1",settled_at:new Date().toISOString() };
  validate("Settlement",settlement);
  await db.query("INSERT INTO service_usage(id,workspace_id,attempt_id,measured_seconds,record) VALUES ($1,$2,$3,$4,$5)",[settlement.settlement_id,row.workspace_id,attemptId,measured,settlement]);
  await emitEvent(db,row,"usage.settled",settlement);
  return settlement;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export class InterviewService {
  pool: Pool;
  key: Buffer;
  origin: string;
  live?: LiveOptions;
  constructor(pool: Pool, encryptionKey: Buffer, origin: string, live?: LiveOptions) {
    this.live = live;
    if (encryptionKey.length !== 32) throw new Error("Service encryption key must be 32 bytes");
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Service origin must be an HTTPS origin");
    this.pool = pool; this.key = encryptionKey; this.origin = url.origin;
  }
  /** Accounts whose settlements carry billable seconds. This is not an allowance; the client enforces its own balance. */
  billableAccountIds: string[] = [];
  liveEnabled(accountId: string) { return this.live?.accountIds.includes(accountId) === true; }
  billed(accountId: string) { return this.billableAccountIds.includes(accountId); }
  capabilities(accountId: string) {
    return this.liveEnabled(accountId) ? { ...capabilities, interviewer_profile_ids: ["pilot_default"], rubric_version_ids: ["pilot_v1"] } : capabilities;
  }
  async principal(header: string | null) { return authenticate(this.pool,header); }

  /** Persist the response with the mutation. Replay survives process restart and key rotation. */
  async command<T>(p: Principal, operation: string, key: string | null, input: unknown, workspaceId: string | null, work: (db: PoolClient) => Promise<T>): Promise<T> {
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new ServiceError(422,"idempotency_key_required");
    const digest = hashToken(canonical(input));
    return transaction(this.pool,async db => {
      if (workspaceId) await workspace(db,p,workspaceId);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [canonical([p.accountId,operation,key])]);
      const previous = await db.query("SELECT * FROM service_commands WHERE account_id=$1 AND operation=$2 AND command_key=$3", [p.accountId,operation,key]);
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (p.workspaceId && row.workspace_id !== p.workspaceId) throw new ServiceError(404,"not_found");
        if (row.erased_at) throw new ServiceError(410,"interview_deleted");
        if (row.interview_id && !operation.startsWith("interview.delete:")) await this.getInterview(db,p,row.interview_id,true);
        if (row.request_hash !== digest) throw new ServiceError(409,"idempotency_conflict");
        return JSON.parse(unseal(row.response_ciphertext,this.key)) as T;
      }
      const result = await work(db);
      await db.query(`INSERT INTO service_commands(account_id,credential_id,workspace_id,operation,command_key,request_hash,response_ciphertext,response_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,200)`, [p.accountId,p.credentialId,workspaceId,operation,key,digest,seal(JSON.stringify(result),this.key)]);
      const resource = result as { id?: string; interview_id?: string };
      const interviewId = operation === "interview.create" ? resource.id : operation.startsWith("interview.") ? operation.split(":")[1] : null;
      if (interviewId) await db.query("UPDATE service_commands SET interview_id=$4 WHERE account_id=$1 AND operation=$2 AND command_key=$3",[p.accountId,operation,key,interviewId]);
      return result;
    });
  }
  async deleteInterview(p: Principal, id: string, key: string | null) { return requestDeletion(this,p,id,key); }
  async deletionStatus(p: Principal, id: string) { return deletionStatus(this,p,id); }
  async createWorkspace(p: Principal, input: {external_reference: string; display_name: string}, key: string | null) {
    requireScope(p,"workspaces:write");
    if (p.workspaceId) throw new ServiceError(403,"forbidden");
    validate("WorkspaceRequest",input);
    return this.command(p,"workspace.create",key,input,null,async db => {
      const existing = await db.query("SELECT * FROM service_workspaces WHERE account_id=$1 AND external_reference=$2", [p.accountId,input.external_reference]);
      let row = existing.rows[0];
      if (row && row.display_name !== input.display_name) throw new ServiceError(409,"external_reference_conflict");
      if (!row) {
        const result = await db.query(`INSERT INTO service_workspaces(id,account_id,external_reference,display_name) VALUES ($1,$2,$3,$4)
          ON CONFLICT (account_id,external_reference) DO UPDATE SET external_reference=EXCLUDED.external_reference RETURNING *`,[newId("ws"),p.accountId,input.external_reference,input.display_name]);
        row = result.rows[0];
        if (row.display_name !== input.display_name) throw new ServiceError(409,"external_reference_conflict");
      }
      return { id: row.id, external_reference: row.external_reference, display_name: row.display_name, created_at: row.created_at.toISOString() };
    });
  }
  async getInterview(db: Pool | PoolClient, p: Principal, id: string, lock = false, includeDeleted = false): Promise<InterviewRow> {
    assertId(id);
    const result = await db.query<InterviewRow>(`SELECT * FROM service_interviews WHERE id=$1 AND account_id=$2
      AND ($3::text IS NULL OR workspace_id=$3) ${lock ? "FOR UPDATE" : ""}`, [id,p.accountId,p.workspaceId]);
    if (!result.rowCount) throw new ServiceError(404,"not_found");
    if (result.rows[0].deletion_requested_at && !includeDeleted) throw new ServiceError(410,"interview_deleted");
    return result.rows[0];
  }
  async createInterview(p: Principal, input: InterviewRequest, key: string | null) {
    requireScope(p,"interviews:write"); validate("CreateInterviewRequest",input);
    try { validateInterviewSemantics(input); } catch { throw new ServiceError(422,"validation_failed","Invalid availability or authorization budget"); }
    return this.command(p,"interview.create",key,input,input.workspace_id,async db => {
      const tombstone = await db.query("SELECT id FROM service_interviews WHERE workspace_id=$1 AND external_reference_hash=$2 AND deletion_requested_at IS NOT NULL",[input.workspace_id,hashToken(input.external_reference)]);
      if (tombstone.rowCount) throw new ServiceError(410,"interview_deleted");
      const c = input.configuration;
      const caps = this.capabilities(p.accountId);
      if (c.mode !== "adaptive" || c.language !== "en" || !caps.interviewer_profile_ids.includes(c.interviewer_profile_id) || !caps.rubric_version_ids.includes(c.rubric_version_id)) throw new ServiceError(422,"unsupported_configuration");
      if (Date.parse(input.availability.last_start_at) <= Date.now()) throw new ServiceError(422,"validation_failed","Start window has expired");
      const result = await db.query<InterviewRow>(`INSERT INTO service_interviews(id,account_id,workspace_id,external_reference,request,execution_provider,external_reference_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`,[newId("int"),p.accountId,input.workspace_id,input.external_reference,input,this.liveEnabled(p.accountId) ? "openai_live" : "fake",hashToken(input.external_reference)]);
      if (!result.rowCount) throw new ServiceError(409,"external_reference_conflict");
      return interviewView(result.rows[0]);
    });
  }
  async readInterview(p: Principal, id: string) {
    requireScope(p,"interviews:read"); return interviewView(await this.getInterview(this.pool,p,id));
  }
  async accessLink(p: Principal, id: string, input: {expires_at: string}, key: string | null) {
    requireScope(p,"interviews:write"); validate("AccessLinkRequest",input);
    const owner = await this.getInterview(this.pool,p,id);
    return this.command(p,`interview.link:${id}`,key,input,owner.workspace_id,async db => {
      const row = await this.getInterview(db,p,id,true);
      const expires = Date.parse(input.expires_at);
      if (row.execution_status !== "ready") throw new ServiceError(409,"invalid_state");
      if (expires <= Date.now() || expires > Date.parse(row.request.availability.last_start_at)) throw new ServiceError(422,"validation_failed","Link expiry must fit the start window");
      // Issuing a new link invalidates any earlier link/session for this unstarted interview.
      await db.query("UPDATE service_access_links SET revoked_at=now() WHERE interview_id=$1 AND revoked_at IS NULL",[id]);
      await db.query("UPDATE service_candidate_sessions SET revoked_at=now() WHERE interview_id=$1 AND revoked_at IS NULL",[id]);
      const token = newToken("invite"); const linkId = newId("link");
      await db.query("INSERT INTO service_access_links(id,interview_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)",[linkId,id,hashToken(token),input.expires_at]);
      return { id: linkId, interview_id: id, url: `${this.origin}/join#${token}`, expires_at: input.expires_at };
    });
  }
  async cancel(p: Principal, id: string, input: {expected_resource_version: number; reason: string}, key: string | null) {
    requireScope(p,"interviews:write"); validate("CancelRequest",input);
    const owner = await this.getInterview(this.pool,p,id);
    return this.command(p,`interview.cancel:${id}`,key,input,owner.workspace_id,async db => {
      const row = await this.getInterview(db,p,id,true);
      if (row.resource_version !== input.expected_resource_version) throw new ServiceError(409,"version_conflict");
      if (!["ready","in_progress"].includes(row.execution_status)) throw new ServiceError(409,"invalid_state");
      if (row.attempt_id && row.execution_provider !== "fake") {
        await db.query("UPDATE service_attempts SET stop_requested_at=coalesce(stop_requested_at,now()),stop_reason='employer_cancel' WHERE id=$1", [row.attempt_id]);
        const updated = (await db.query<InterviewRow>("UPDATE service_interviews SET execution_status='cancelled',usage_status='provisional',assessment_status='not_requested',resource_version=resource_version+1,updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0];
        await db.query("UPDATE service_access_links SET revoked_at=now() WHERE interview_id=$1", [id]);
        await db.query("UPDATE service_candidate_sessions SET revoked_at=now() WHERE interview_id=$1", [id]);
        await emitEvent(db,updated,"interview.cancelled");
        return interviewView(updated);
      }
      const updated = (await db.query<InterviewRow>(`UPDATE service_interviews SET execution_status='cancelled',assessment_status='not_requested',usage_status='settled',resource_version=resource_version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id])).rows[0];
      await db.query("UPDATE service_access_links SET revoked_at=now() WHERE interview_id=$1",[id]);
      await db.query("UPDATE service_candidate_sessions SET revoked_at=now() WHERE interview_id=$1",[id]);
      await db.query("UPDATE service_reservations SET status='released' WHERE interview_id=$1 AND status='reserved'",[id]);
      // Only the sandbox adapter exists here; live cancellation must await authoritative closure.
      await db.query("UPDATE service_attempts SET ended_at=now() WHERE interview_id=$1 AND ended_at IS NULL",[id]);
      await emitEvent(db,updated,"interview.cancelled");
      if (row.attempt_id) {
        const attempt = (await db.query("SELECT observations FROM service_attempts WHERE id=$1",[row.attempt_id])).rows[0];
        await recordShadowUsage(db,updated,row.attempt_id,Math.ceil((attempt.observations.cumulativeAudioMs ?? 0)/1000));
      }
      return interviewView(updated);
    });
  }
  async readResult(p: Principal,id: string) {
    requireScope(p,"interviews:read"); const row = await this.getInterview(this.pool,p,id);
    const result = await this.pool.query("SELECT a.result FROM service_attempts a JOIN service_interviews i ON i.id=a.interview_id WHERE a.id=$1 AND i.deletion_requested_at IS NULL",[row.attempt_id]);
    if (!result.rows[0]?.result) throw new ServiceError(409,row.assessment_status === "failed" ? "result_failed" : "result_pending");
    return result.rows[0].result;
  }
  async usage(p: Principal, workspaceId: string, cursor: string | null) {
    requireScope(p,"usage:read"); await workspace(this.pool,p,workspaceId);
    if (cursor && !/^[0-9]{1,18}$/.test(cursor)) throw new ServiceError(422,"validation_failed");
    const rows = (await this.pool.query("SELECT u.sequence,u.record FROM service_usage u JOIN service_attempts a ON a.id=u.attempt_id JOIN service_interviews i ON i.id=a.interview_id WHERE u.workspace_id=$1 AND u.sequence>$2 AND i.deletion_requested_at IS NULL ORDER BY u.sequence LIMIT 101",[workspaceId,cursor ?? "0"])).rows;
    return { data: rows.slice(0,100).map(r => r.record), next_cursor: rows.length > 100 ? String(rows[99].sequence) : null };
  }
  async balance(p: Principal, workspaceId: string) {
    requireScope(p,"usage:read"); await workspace(this.pool,p,workspaceId);
    return { workspace_id: workspaceId, available_credits:"0.000000",reserved_credits:"0.000000",unlimited:false,as_of:new Date().toISOString() };
  }
  async webhookEndpoint(p: Principal,input: {url: string; event_types: string[]},key: string | null) {
    requireScope(p,"webhooks:write"); if (p.workspaceId) throw new ServiceError(403,"forbidden");
    validate("WebhookEndpointRequest",input);
    let url: URL;
    try {
      url = webhookUrl(input.url);
    } catch {
      throw new ServiceError(422,"validation_failed");
    }
    return this.command(p,"webhook.create",key,input,null,async db => {
      const secret = newToken("whsec"); const id = newId("we");
      const inserted = await db.query(`INSERT INTO service_webhook_endpoints(id,account_id,url,secret_ciphertext,event_types)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id,url) DO NOTHING`, [id,p.accountId,url.href,seal(secret,this.key),input.event_types]);
      if (!inserted.rowCount) throw new ServiceError(409,"endpoint_exists");
      return { id, url: url.href, status: "pending_verification", signing_secret: secret };
    });
  }
}
