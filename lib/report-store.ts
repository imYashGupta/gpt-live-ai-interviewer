import "server-only";

import { getDatabase } from "@/lib/database";
import type { InterviewReport } from "@/lib/interview-report";

export function getInterviewReport(id: string): InterviewReport | null {
  const row = getDatabase().prepare(
    "SELECT report_json FROM interview_reports WHERE interview_id = ?",
  ).get(id) as { report_json: string | null } | undefined;
  return row?.report_json ? JSON.parse(row.report_json) as InterviewReport : null;
}

export function claimReportGeneration(id: string, token: string) {
  const now = Date.now();
  return getDatabase().prepare(`
    INSERT INTO interview_reports (interview_id, lease_token, generation_started_at)
    VALUES (?, ?, ?)
    ON CONFLICT(interview_id) DO UPDATE SET
      lease_token = excluded.lease_token,
      generation_started_at = excluded.generation_started_at
    WHERE report_json IS NULL AND generation_started_at < ?
  `).run(id, token, now, now - 90_000).changes === 1;
}

export function saveInterviewReport(report: InterviewReport, token: string) {
  const database = getDatabase();
  return database.transaction(() => {
    const result = database.prepare(`
      UPDATE interview_reports SET report_json = ?
      WHERE interview_id = ? AND lease_token = ? AND report_json IS NULL
    `).run(JSON.stringify(report), report.id, token);
    if (result.changes !== 1) return false;
    database.prepare(`
      UPDATE interviews SET estimated_cost_usd = estimated_cost_usd + ? WHERE id = ?
    `).run(report.generation?.estimatedCostUsd ?? 0, report.id);
    return true;
  })();
}

export function releaseReportGeneration(id: string, token: string) {
  getDatabase().prepare(`
    DELETE FROM interview_reports WHERE interview_id = ? AND lease_token = ? AND report_json IS NULL
  `).run(id, token);
}
