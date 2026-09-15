"use client";

import { useEffect, useState } from "react";

import { InterviewReportView } from "@/components/interview-report";
import type { InterviewReport } from "@/lib/interview-report";
import type { TranscriptEntry } from "@/lib/types";

export function InterviewReportLoader({ id, openaiSessionId, transcript, usageSeconds, report, onReady }: {
  id: string | null;
  openaiSessionId: string | null;
  transcript: TranscriptEntry[];
  usageSeconds: number | null;
  report: InterviewReport | null;
  onReady: (report: InterviewReport) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || !openaiSessionId || report) return;
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(100_000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    async function generate() {
      try {
        for (let poll = 0; poll < 45; poll += 1) {
          const response = await fetch("/api/interviews/report", {
            method: "POST", headers: { "Content-Type": "application/json" }, signal,
            body: JSON.stringify({ id, openaiSessionId, transcript, actualSeconds: usageSeconds }),
          });
          const result = await response.json();
          if (result.code === "report_pending" && response.status === 409) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            if (signal.aborted) return;
            continue;
          }
          if (!response.ok || !result.report) throw new Error(result.error || "The report could not be generated.");
          if (!signal.aborted) onReady(result.report);
          return;
        }
        throw new Error("The report is taking longer than expected. Please retry shortly.");
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(timeout.aborted ? "The report is taking longer than expected. Please retry." :
          failure instanceof Error ? failure.message : "The report could not be generated.");
      }
    }
    // Let the terminal session event and any final transcript state updates settle.
    const start = setTimeout(() => void generate(), 0);
    return () => { clearTimeout(start); controller.abort(); };
  }, [id, openaiSessionId, transcript, usageSeconds, report, onReady, attempt]);

  if (report) return <InterviewReportView report={report} />;
  const missingSession = !id || !openaiSessionId;
  return <section className="report-loading report-card" aria-live="polite" aria-busy={!error && !missingSession}>
    <span className="report-loading-icon" aria-hidden="true">{error || missingSession ? "!" : "✦"}</span>
    <p className="panel-kicker">Interview complete</p>
    <h1>{error || missingSession ? "Your report is not ready" : "Putting your interview into perspective"}</h1>
    <p>{missingSession ? "No interview session was created, so there is nothing to assess yet." : error || "Reviewing your answers, checking the evidence, and preparing your performance charts. This may take about a minute."}</p>
    {error && !missingSession && <button className="secondary-button" type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Retry report</button>}
    {!error && !missingSession && <div className="report-loading-steps"><span>Answer accuracy</span><span>Technical depth</span><span>Actionable feedback</span></div>}
  </section>;
}
