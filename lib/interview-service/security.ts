import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export class ServiceError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message = code) { super(message); this.status = status; this.code = code; }
}
export interface Principal { accountId: string; credentialId: string; workspaceId: string | null; scopes: string[] }
export const newId = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
export const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export function assertId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new ServiceError(422,"validation_failed");
  return value;
}
export function seal(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
export function unseal(value: string, key: Buffer): string {
  const bytes = Buffer.from(value, "base64url");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0,12));
  cipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString("utf8");
}
export async function authenticate(db: Pool | PoolClient, header: string | null): Promise<Principal> {
  if (!header || !/^Bearer isk_test_[A-Za-z0-9_-]{43}$/.test(header)) throw new ServiceError(401,"invalid_credentials");
  const found = await db.query(`SELECT c.* FROM service_credentials c JOIN service_accounts a ON a.id=c.account_id
    WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>now() AND a.disabled_at IS NULL`, [hashToken(header.slice(7))]);
  if (!found.rowCount) throw new ServiceError(401,"invalid_credentials");
  const c = found.rows[0];
  return { accountId: c.account_id, credentialId: c.id, workspaceId: c.workspace_id, scopes: c.scopes };
}
export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) throw new ServiceError(403,"forbidden");
}
export async function workspace(db: Pool | PoolClient, p: Principal, id: string, lock = false) {
  assertId(id);
  if (p.workspaceId && p.workspaceId !== id) throw new ServiceError(404,"not_found");
  const found = await db.query(`SELECT * FROM service_workspaces WHERE id=$1 AND account_id=$2 ${lock ? "FOR UPDATE" : ""}`, [id,p.accountId]);
  if (!found.rowCount) throw new ServiceError(404,"not_found");
  return found.rows[0];
}
export async function issueCredential(db: PoolClient, accountId: string, workspaceId: string | null = null) {
  assertId(accountId);
  if (workspaceId) {
    assertId(workspaceId);
    if (!(await db.query("SELECT id FROM service_workspaces WHERE id=$1 AND account_id=$2",[workspaceId,accountId])).rowCount) throw new Error("Workspace not found in this account");
  }
  if (!(await db.query("SELECT id FROM service_accounts WHERE id=$1 AND disabled_at IS NULL",[accountId])).rowCount) throw new Error("Active account not found");
  const credentialId = newId("key"), token = newToken("isk_test");
  const scopes = workspaceId ? ["interviews:read","interviews:write","usage:read"]
    : ["workspaces:write","interviews:read","interviews:write","usage:read","webhooks:write"];
  await db.query(`INSERT INTO service_credentials(id,account_id,workspace_id,token_hash,scopes,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+interval '90 days')`,[credentialId,accountId,workspaceId,hashToken(token),scopes]);
  return { accountId, credentialId, workspaceId, token };
}
export async function provisionAccount(db: PoolClient, name: string) {
  if (!name.trim() || name.length > 120) throw new Error("Account name must contain 1 to 120 characters");
  const accountId = newId("acct");
  await db.query("INSERT INTO service_accounts(id,name) VALUES ($1,$2)",[accountId,name]);
  return issueCredential(db,accountId);
}
