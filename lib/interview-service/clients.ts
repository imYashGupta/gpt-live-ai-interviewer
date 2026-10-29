import type { Pool, PoolClient } from "pg";
import { newId, newToken, provisionAccount, seal } from "./security.ts";
import { webhookUrl } from "./delivery.ts";

/** Lowercase operator-facing client names such as recooty, recooty_dev or recooty_staging. */
export const CLIENT_NAME = /^[a-z][a-z0-9_]{1,62}$/;

/** A client is one account, one account-level credential and the single workspace its interviews belong to. */
export async function createClient(db: PoolClient, name: string) {
  if (!CLIENT_NAME.test(name)) throw new Error("Client name must be lowercase letters, digits or underscores, starting with a letter (e.g. recooty_staging)");
  if ((await db.query("SELECT 1 FROM service_accounts WHERE lower(name)=lower($1)",[name])).rowCount) throw new Error(`Client ${name} already exists`);
  const account = await provisionAccount(db,name);
  const workspaceId = newId("ws");
  await db.query("INSERT INTO service_workspaces(id,account_id,external_reference,display_name) VALUES ($1,$2,$3,$4)",[workspaceId,account.accountId,"default",name]);
  return { ...account, clientWorkspaceId: workspaceId };
}

/** Every event a client can receive; clients re-read state on each, so subscribing to all is safe. */
export const WEBHOOK_EVENTS = ["interview.started","interview.completed","interview.interrupted","interview.failed","interview.cancelled",
  "interview.expired","interview.deleted","result.ready","result.failed","usage.settled","usage.adjusted"];

/**
 * Operator-registered webhook: active at once, since the operator running this is the ownership check.
 * Re-running for the same URL issues a new secret; the client keeps the old one as its previous secret while switching.
 */
export async function registerWebhook(db: PoolClient, accountId: string, url: string, key: Buffer) {
  const target = webhookUrl(url);
  const secret = newToken("whsec");
  const id = (await db.query(`INSERT INTO service_webhook_endpoints(id,account_id,url,secret_ciphertext,event_types,status)
    VALUES ($1,$2,$3,$4,$5,'active') ON CONFLICT (account_id,url) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,
    event_types=EXCLUDED.event_types,status='active' RETURNING id`,[newId("we"),accountId,target.href,seal(secret,key),WEBHOOK_EVENTS])).rows[0].id as string;
  return { id, url: target.href, secret };
}

export async function renameClient(db: Pool | PoolClient, accountId: string, name: string) {
  if (!CLIENT_NAME.test(name)) throw new Error("Client name must be lowercase letters, digits or underscores, starting with a letter");
  const result = await db.query("UPDATE service_accounts SET name=$2 WHERE id=$1",[accountId,name]);
  if (!result.rowCount) throw new Error("Client account not found");
}

/** Month bounds in UTC for a YYYY-MM string, defaulting to the current month. */
export function monthRange(month?: string) {
  const value = month ?? new Date().toISOString().slice(0,7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error("Month must be YYYY-MM");
  const start = new Date(`${value}-01T00:00:00Z`);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth()+1);
  return { month: value, start, end };
}

/**
 * Per-client interviews and settled seconds for one month and in total. Measured seconds are what the provider ran;
 * billable seconds are what the client may charge (service failures and synthetic interviews are zero).
 */
export async function clientUsage(db: Pool | PoolClient, month?: string) {
  const { start, end } = monthRange(month);
  const rows = (await db.query(`
    SELECT a.name AS client, a.id AS account_id, a.disabled_at IS NOT NULL AS disabled,
      (SELECT count(*) FROM service_interviews i WHERE i.account_id=a.id AND i.created_at>=$1 AND i.created_at<$2)::integer AS interviews_month,
      coalesce(sum(u.measured_seconds) FILTER (WHERE u.created_at>=$1 AND u.created_at<$2),0)::bigint AS measured_seconds_month,
      coalesce(sum((u.record->>'billable_quantity')::bigint) FILTER (WHERE u.created_at>=$1 AND u.created_at<$2),0)::bigint AS billable_seconds_month,
      (SELECT count(*) FROM service_interviews i WHERE i.account_id=a.id)::integer AS interviews_total,
      coalesce(sum((u.record->>'billable_quantity')::bigint),0)::bigint AS billable_seconds_total
    FROM service_accounts a
    LEFT JOIN service_workspaces w ON w.account_id=a.id
    LEFT JOIN service_usage u ON u.workspace_id=w.id
    GROUP BY a.id ORDER BY a.name`,[start,end])).rows;
  return rows.map(r => ({ ...r, measured_seconds_month: Number(r.measured_seconds_month), billable_seconds_month: Number(r.billable_seconds_month),
    billable_seconds_total: Number(r.billable_seconds_total) }));
}
