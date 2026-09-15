import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireApiAccess } from "@/lib/api-access";
import { getDatabase } from "@/lib/database";
import { completeInterviewLog } from "@/lib/interview-log";
import { overallReportScore, validateReportTranscript } from "@/lib/interview-report";
import { generateInterviewReport } from "@/lib/report-generation";
import { claimReportGeneration, getInterviewReport, releaseReportGeneration, saveInterviewReport } from "@/lib/report-store";
import type { InterviewReport } from "@/lib/interview-report";
import type { InterviewConfig } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

const json = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function POST(request: NextRequest) {
  const accessError = requireApiAccess(request);
  if (accessError) return accessError;

  let body: Record<string, unknown>;
  try {
    // Cap bytes while reading, before allocating or parsing an arbitrary request.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "A report request is required." }, 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        return json({ error: "The transcript is too large to assess." }, 413);
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json({ error: "Invalid JSON request body." }, 400);
  }
  if (!body || typeof body !== "object" ||
    typeof body.id !== "string" || !body.id || body.id.length > 100 ||
    typeof body.openaiSessionId !== "string" || !body.openaiSessionId || body.openaiSessionId.length > 255 ||
    (body.actualSeconds !== null && (typeof body.actualSeconds !== "number" ||
      !Number.isFinite(body.actualSeconds) || body.actualSeconds < 0 || body.actualSeconds > 7_200))) {
    return json({ error: "A valid interview reference and usage are required." }, 400);
  }
  const transcript = validateReportTranscript(body.transcript);
  if (!transcript) return json({ error: "The interview transcript is invalid or too large." }, 400);

  const id = body.id;
  const token = randomUUID();
  let claimed = false;
  try {
    const session = getDatabase().prepare(`
      SELECT report_context_json, actual_seconds FROM interviews WHERE id = ? AND openai_session_id = ?
    `).get(id, body.openaiSessionId) as {
      report_context_json: string | null; actual_seconds: number | null;
    } | undefined;
    if (!session) return json({ error: "This interview could not be found." }, 404);
    const saved = getInterviewReport(id);
    if (saved) return json({ report: saved });
    if (!session.report_context_json) return json({ error: "Reports are available for new interviews only." }, 409);
    claimed = claimReportGeneration(id, token);
    if (!claimed) return json({ error: "The report is already being generated. Please retry shortly.", code: "report_pending" }, 409);

    completeInterviewLog({ id, openaiSessionId: body.openaiSessionId, actualSeconds: body.actualSeconds as number | null });
    const config = JSON.parse(session.report_context_json) as InterviewConfig;
    const { analysis, generation } = await generateInterviewReport(config, transcript);
    const report: InterviewReport = {
      ...analysis, id, createdAt: new Date().toISOString(),
      candidateName: config.candidateName, role: config.role, difficulty: config.difficulty,
      durationSeconds: session.actual_seconds ?? body.actualSeconds as number | null,
      transcript, generation, overallScore: overallReportScore(analysis),
    };
    if (!saveInterviewReport(report, token)) throw new Error("Report generation lease expired.");
    return json({ report }, 201);
  } catch {
    if (claimed) releaseReportGeneration(id, token);
    console.error("Interview report generation failed");
    return json({ error: "The report could not be generated. Your transcript is still available; please retry." }, 502);
  }
}
