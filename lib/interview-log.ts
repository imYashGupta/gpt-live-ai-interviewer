import "server-only";

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { GPT_LIVE_PRICE_USD_PER_MINUTE } from "@/lib/types";
import type { InterviewConfig, InterviewPlan } from "@/lib/types";

type InterviewLogDatabase = InstanceType<typeof Database>;

interface CreateInterviewLogInput {
  headers: Headers;
  openaiSessionId: string;
  interview: InterviewConfig;
  plan: InterviewPlan | null;
}

interface CompleteInterviewLogInput {
  id: string;
  openaiSessionId: string;
  actualSeconds: number | null;
}

const globalForInterviewLog = globalThis as typeof globalThis & {
  interviewLogDatabase?: InterviewLogDatabase;
  interviewLogSchemaVersion?: number;
};

const INTERVIEW_LOG_SCHEMA_VERSION = 2;

export function createInterviewLog({
  headers,
  openaiSessionId,
  interview,
  plan,
}: CreateInterviewLogInput) {
  const id = randomUUID();
  const database = getDatabase();
  const plannedLiveCost =
    interview.durationMinutes * GPT_LIVE_PRICE_USD_PER_MINUTE;

  database
    .prepare(
      `INSERT INTO interviews (
        id,
        openai_session_id,
        ip_address,
        status,
        mode,
        role,
        difficulty,
        planned_minutes,
        actual_seconds,
        plan_input_tokens,
        plan_output_tokens,
        estimated_cost_usd,
        started_at,
        ended_at
      ) VALUES (?, ?, ?, 'started', ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      openaiSessionId,
      getClientIp(headers),
      interview.mode,
      interview.role,
      interview.difficulty,
      interview.durationMinutes,
      plan?.generation.inputTokens ?? 0,
      plan?.generation.outputTokens ?? 0,
      (plan?.generation.estimatedCostUsd ?? 0) + plannedLiveCost,
      new Date().toISOString(),
    );

  return id;
}

export function completeInterviewLog({
  id,
  openaiSessionId,
  actualSeconds,
}: CompleteInterviewLogInput) {
  const liveCost =
    actualSeconds === null
      ? 0
      : (actualSeconds / 60) * GPT_LIVE_PRICE_USD_PER_MINUTE;
  const status = actualSeconds === null ? "ended_without_usage" : "completed";

  const result = getDatabase()
    .prepare(
      `UPDATE interviews
       SET status = ?,
           actual_seconds = ?,
           estimated_cost_usd = estimated_cost_usd - (? * planned_minutes) + ?,
           ended_at = ?
       WHERE id = ?
         AND openai_session_id = ?
         AND status = 'started'`,
    )
    .run(
      status,
      actualSeconds,
      GPT_LIVE_PRICE_USD_PER_MINUTE,
      liveCost,
      new Date().toISOString(),
      id,
      openaiSessionId,
    );

  return result.changes === 1;
}

function getDatabase() {
  let database = globalForInterviewLog.interviewLogDatabase;

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
    globalForInterviewLog.interviewLogDatabase = database;
  }

  if (globalForInterviewLog.interviewLogSchemaVersion !== INTERVIEW_LOG_SCHEMA_VERSION) {
    ensureSchema(database);
    globalForInterviewLog.interviewLogSchemaVersion = INTERVIEW_LOG_SCHEMA_VERSION;
  }

  return database;
}

function ensureSchema(database: InterviewLogDatabase) {
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
    CREATE INDEX IF NOT EXISTS interviews_ip_address_started_at_idx
      ON interviews (ip_address, started_at);
  `);
}

function getClientIp(headers: Headers) {
  const directIpHeaders = [
    "cf-connecting-ip",
    "x-vercel-forwarded-for",
    "x-real-ip",
  ];

  for (const header of directIpHeaders) {
    const value = headers.get(header)?.trim();
    if (value) return firstForwardedValue(value);
  }

  const forwardedFor = headers.get("x-forwarded-for");
  return forwardedFor ? firstForwardedValue(forwardedFor) : "unknown";
}

function firstForwardedValue(value: string) {
  return value.split(",", 1)[0].trim().slice(0, 128) || "unknown";
}
