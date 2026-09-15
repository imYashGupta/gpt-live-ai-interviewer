import "server-only";

import { randomUUID } from "node:crypto";

import { getClientIp } from "@/lib/client-ip";
import { getDatabase } from "@/lib/database";
import { GPT_LIVE_PRICE_USD_PER_MINUTE } from "@/lib/types";
import type { InterviewConfig, InterviewPlan } from "@/lib/types";

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
        ended_at,
        report_context_json
      ) VALUES (?, ?, ?, 'started', ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
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
      JSON.stringify({ ...interview, candidateNotes: "" }),
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
