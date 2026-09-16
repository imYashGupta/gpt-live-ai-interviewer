import { Pool, type PoolClient } from "pg";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export function createServicePool(connectionString: string, schema = "public"): Pool {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid database schema");
  return new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10_000, options: `-c search_path=${schema} -c statement_timeout=15000` });
}

export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}

/** Explicit operator command; never migrate as a side effect of serving a request. */
export async function migrateService(pool: Pool): Promise<void> {
  const sql = await readFile(new URL("./migrations/001_foundations.sql", import.meta.url), "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(71020301)");
    await db.query("CREATE TABLE IF NOT EXISTS service_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const previous = await db.query("SELECT checksum FROM service_migrations WHERE version=1");
    if (previous.rowCount) {
      if (previous.rows[0].checksum !== hash) throw new Error("Applied migration checksum changed");
      return;
    }
    await db.query(sql);
    await db.query("INSERT INTO service_migrations(version,checksum) VALUES (1,$1)", [hash]);
  });
}
