"use client";

import { REPORT_METRICS, reportScoreLabel } from "@/lib/interview-report";
import type { InterviewReport, ReportObservation } from "@/lib/interview-report";
import type { TranscriptEntry } from "@/lib/types";

export function InterviewReportView({ report, standalone = false }: { report: InterviewReport; standalone?: boolean }) {
  const assessedAnswers = report.answers.filter((answer) => answer.score !== null).length;

  return (
    <article className="interview-report" aria-labelledby="report-title">
      <div className="report-toolbar">
        <p className="panel-kicker">Interview insights <span> / </span> Completed session</p>
        <div className="report-actions">
          {!standalone && <a className="secondary-button" href={`/interviews/${report.id}/report`}>Open saved report</a>}
          <button className="secondary-button" type="button" onClick={() => window.print()}>Print / save PDF</button>
        </div>
      </div>

      <header className="report-hero">
        <div className="report-intro">
          <p className="panel-kicker">Performance review</p>
          <h1 id="report-title">{report.candidateName}<span>Interview report</span></h1>
          <p className="report-context">{report.role} <span>·</span> {report.difficulty} level</p>
          <div className="report-facts">
            <span>{new Date(report.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
            <span>{report.durationSeconds === null ? "Duration unavailable" : formatDuration(report.durationSeconds)}</span>
            <span>{assessedAnswers} {assessedAnswers === 1 ? "answer" : "answers"} assessed</span>
          </div>
        </div>
        <div className="report-overall">
          <span className="report-overall-caption">Overall assessment</span>
          <strong>{report.overallScore ?? "—"}<small>{report.overallScore === null ? "" : "/ 100"}</small></strong>
          <span>{report.overallScore === null ? "More evidence needed" : reportScoreLabel(report.overallScore)}</span>
          <p>{report.overallScore === null ? "Requires two assessed answers and all four core skills." : "Equal average of the four core skills."}</p>
        </div>
      </header>

      <section className="report-summary report-card" aria-labelledby="report-summary-title">
        <div><p className="panel-kicker">The overview</p><h2 id="report-summary-title">What the answers show</h2></div>
        <p>{report.summary}</p>
      </section>

      <div className="report-chart-grid">
        <section className="report-card" aria-labelledby="report-skills-title">
          <div className="report-section-heading"><div><p className="panel-kicker">01 / Skill profile</p><h2 id="report-skills-title">Performance by area</h2></div><span>out of 100</span></div>
          <div className="report-metrics">
            {REPORT_METRICS.map(({ id, label, description }) => {
              const metric = report.metrics[id];
              return <div className={`report-metric ${id === "answerConfidence" ? "report-confidence" : ""}`} key={id}>
                <div className="report-metric-heading"><span>{label}</span><strong>{metric.score ?? "Not assessed"}</strong></div>
                <div className="report-bar-track" role="img" aria-label={`${label}: ${metric.score === null ? "not assessed" : `${metric.score} out of 100`}`}>
                  {metric.score !== null && <span style={{ width: `${metric.score}%` }} />}
                </div>
                <details className="report-metric-details"><summary>Reasoning &amp; evidence</summary><p className="report-muted">{description}</p><p>{metric.rationale}</p><Evidence ids={metric.evidenceIds} transcript={report.transcript} /></details>
              </div>;
            })}
          </div>
          <p className="report-chart-note">Expressed confidence reflects the words used in answers. It is excluded from the overall score.</p>
        </section>

        <section className="report-card" aria-labelledby="report-answers-title">
          <div className="report-section-heading"><div><p className="panel-kicker">02 / Answer quality</p><h2 id="report-answers-title">Across the conversation</h2></div><span>out of 100</span></div>
          {report.answers.length > 0 ? <>
            <div className="report-answer-chart">
              <div className="report-chart-axis" aria-hidden="true"><span>100</span><span>50</span><span>0</span></div>
              <div className="report-chart-columns">
                {report.answers.map((answer, index) => <a key={answer.questionId} className="report-chart-column" href={`#report-answer-${index}`} aria-label={`Answer ${index + 1}, ${answer.topic}: ${answer.score === null ? "not assessed" : `${answer.score} out of 100`}`}>
                  <div className="report-column-space"><div className={`report-column-bar ${answer.score === null ? "unassessed" : ""}`} style={{ height: `${answer.score ?? 0}%` }}><span>{answer.score ?? "N/A"}</span></div></div>
                  <span className="report-column-label">{index + 1}</span>
                </a>)}
              </div>
            </div>
            <ol className="report-topic-legend">{report.answers.map((answer, index) => <li key={answer.questionId}><a href={`#report-answer-${index}`}>{answer.topic}</a></li>)}</ol>
          </> : <div className="report-chart-empty"><span>—</span><p>No role-related answers to chart yet.</p></div>}
          <p className="report-chart-note">Questions appear in conversation order. Select a bar to read the feedback. Missing evidence is shown as N/A.</p>
        </section>
      </div>

      <div className="report-observation-grid">
        <ObservationCard title="What worked well" kicker="Strengths" items={report.strengths} transcript={report.transcript} empty="There is not enough evidence to identify strengths yet." />
        <ObservationCard title="Where to go deeper" kicker="Development areas" items={report.improvements} transcript={report.transcript} empty="No specific development areas could be established from the captured answers." />
      </div>

      {report.answers.length > 0 && <section className="report-card report-answer-review" aria-labelledby="answer-review-title">
        <p className="panel-kicker">A closer look</p><h2 id="answer-review-title">Answer-by-answer feedback</h2>
        {report.answers.map((answer, index) => {
          const question = report.transcript.find((entry) => entry.id === answer.questionId);
          return <section className="report-answer" id={`report-answer-${index}`} key={answer.questionId} aria-labelledby={`answer-title-${index}`}>
            <div className="report-answer-heading"><span className="report-answer-number">{String(index + 1).padStart(2, "0")}</span><div><h3 id={`answer-title-${index}`}>{answer.topic}</h3><p>{question?.text}</p></div><strong className="report-score-badge">{answer.score === null ? "Not assessed" : `${answer.score} / 100`}</strong></div>
            <p>{answer.rationale}</p><p className="report-answer-next"><strong>Next step</strong> {answer.improvement}</p>
            <details className="report-evidence-details"><summary>View answer evidence</summary><Evidence ids={answer.evidenceIds} transcript={report.transcript} /></details>
          </section>;
        })}
      </section>}

      {report.nextSteps.length > 0 && <section className="report-card report-next-steps" aria-labelledby="report-next-title"><div><p className="panel-kicker">Keep building</p><h2 id="report-next-title">A focused practice plan</h2></div><ol>{report.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ol></section>}

      <footer className="report-methodology">
        <h2>How to read this report</h2>
        <p>AI-generated feedback based on the captured text transcript. Scores describe demonstrated answers for this role and level; they are not percentiles or a hiring recommendation. Transcription errors and limited topic coverage can affect the assessment. Review the evidence alongside each score.</p>
        <p><strong>Score guide:</strong> 0–24 major misconceptions · 25–49 significant gaps · 50–69 developing · 70–84 solid · 85–100 strong. Unassessed areas have no score.</p>
        <p>Confidence means confidence expressed in the content of answers. Voice, body language, emotions, and internal confidence are not assessed.</p>
      </footer>
    </article>
  );
}

function Evidence({ ids, transcript }: { ids: string[]; transcript: TranscriptEntry[] }) {
  return <div className="report-evidence">{ids.map((id) => {
    const entry = transcript.find((item) => item.id === id);
    if (!entry) return null;
    return <blockquote key={id}><cite>Candidate · {formatDuration(entry.startMs / 1_000)}</cite><p>{entry.text}</p></blockquote>;
  })}</div>;
}

function ObservationCard({ title, kicker, items, transcript, empty }: { title: string; kicker: string; items: ReportObservation[]; transcript: TranscriptEntry[]; empty: string }) {
  return <section className="report-card"><p className="panel-kicker">{kicker}</p><h2>{title}</h2>{items.length ? <ul className="report-observations">{items.map((item, index) => <li key={index}><p>{item.text}</p><details className="report-evidence-details"><summary>View evidence</summary><Evidence ids={item.evidenceIds} transcript={transcript} /></details></li>)}</ul> : <p className="report-muted">{empty}</p>}</section>;
}

function formatDuration(seconds: number) {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}m ${String(rounded % 60).padStart(2, "0")}s`;
}
