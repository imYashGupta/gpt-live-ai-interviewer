import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type AppDatabase = InstanceType<typeof Database>;

const globalForDatabase = globalThis as typeof globalThis & {
  appDatabase?: AppDatabase;
  appDatabaseSchemaVersion?: number;
};

const APP_DATABASE_SCHEMA_VERSION = 4;

export function getDatabase() {
  let database = globalForDatabase.appDatabase;

  if (!database) {
    const configuredPath = process.env.SQLITE_DATABASE_PATH?.trim();
    const databasePath = path.resolve(
      /* turbopackIgnore: true */
      process.cwd(),
      configuredPath || ".data/interviews.sqlite",
    );
    mkdirSync(path.dirname(databasePath), { recursive: true });

    database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma("busy_timeout = 5000");
    globalForDatabase.appDatabase = database;
  }

  if (globalForDatabase.appDatabaseSchemaVersion !== APP_DATABASE_SCHEMA_VERSION) {
    ensureSchema(database);
    globalForDatabase.appDatabaseSchemaVersion = APP_DATABASE_SCHEMA_VERSION;
  }

  return database;
}

function ensureSchema(database: AppDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY,
      openai_session_id TEXT NOT NULL UNIQUE,
      ip_address TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('started', 'completed', 'ended_without_usage')
      ),
      mode TEXT NOT NULL CHECK (mode IN ('ai-led', 'planned')),
      role TEXT NOT NULL,
      difficulty TEXT NOT NULL CHECK (difficulty IN ('junior', 'mid', 'senior')),
      planned_minutes INTEGER NOT NULL CHECK (planned_minutes BETWEEN 1 AND 60),
      actual_seconds REAL CHECK (actual_seconds IS NULL OR actual_seconds >= 0),
      plan_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (plan_input_tokens >= 0),
      plan_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (plan_output_tokens >= 0),
      estimated_cost_usd REAL NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
  `);

  const columns = database.pragma("table_info(interviews)") as Array<{
    name: string;
  }>;
  if (!columns.some(({ name }) => name === "report_context_json")) {
    database.exec("ALTER TABLE interviews ADD COLUMN report_context_json TEXT");
  }
  if (
    columns.some(({ name }) => name === "ip_hash") &&
    !columns.some(({ name }) => name === "ip_address")
  ) {
    database.transaction(() => {
      database.exec("DROP INDEX IF EXISTS interviews_ip_hash_started_at_idx");
      database.exec("ALTER TABLE interviews RENAME COLUMN ip_hash TO ip_address");
      database.prepare("UPDATE interviews SET ip_address = 'unavailable'").run();
    })();
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS interview_reports (
      interview_id TEXT PRIMARY KEY REFERENCES interviews(id),
      report_json TEXT,
      lease_token TEXT NOT NULL,
      generation_started_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS interviews_ip_address_started_at_idx
      ON interviews (ip_address, started_at);

    CREATE TABLE IF NOT EXISTS passcode_rate_limits (
      ip_address TEXT PRIMARY KEY,
      failed_attempts INTEGER NOT NULL CHECK (failed_attempts >= 0),
      window_started_at INTEGER NOT NULL
    );
  `);
}
