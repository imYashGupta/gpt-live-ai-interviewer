import Database from "better-sqlite3";
import type { Pool } from "pg";
import { transaction } from "./postgres.ts";
import { hashToken } from "./security.ts";

/** Read-only archive import. Prototype records never become customer interviews or usage. */
export async function importLegacy(pool: Pool, path: string) {
  const sqlite = new Database(path,{readonly:true,fileMustExist:true});
  try {
    sqlite.exec("BEGIN");
    const hasReports = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='interview_reports'").get();
    const report = hasReports ? sqlite.prepare("SELECT report_json FROM interview_reports WHERE interview_id=?") : null;
    let imported = 0;
    await transaction(pool,async db => {
      const accountId = "acct_internal_legacy_demo";
      await db.query("INSERT INTO service_accounts(id,name) VALUES ($1,'Internal/demo legacy archive') ON CONFLICT (id) DO NOTHING",[accountId]);
      for (const row of sqlite.prepare("SELECT id,mode,role,difficulty,planned_minutes,actual_seconds,status,started_at,ended_at FROM interviews ORDER BY id").iterate() as Iterable<Record<string,unknown>>) {
        const stored = report?.get(row.id) as { report_json: string | null } | undefined;
        const snapshot = { classification:"internal_demo", billable:false, ...row, report: stored?.report_json ? JSON.parse(stored.report_json) : null };
        const fingerprint = hashToken(JSON.stringify(snapshot));
        const previous = (await db.query("SELECT source_hash FROM service_legacy_imports WHERE account_id=$1 AND legacy_id=$2",[accountId,row.id])).rows[0];
        if (previous) {
          if (previous.source_hash !== fingerprint) throw new Error("Legacy archive changed; review it before reimporting");
          continue;
        }
        await db.query("INSERT INTO service_legacy_imports(source_hash,account_id,legacy_id,snapshot) VALUES ($1,$2,$3,$4)",[fingerprint,accountId,row.id,snapshot]);
        imported++;
      }
    });
    return imported;
  } finally { sqlite.close(); }
}
