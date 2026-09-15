"use client";

import type { RefObject } from "react";

import { DebugPanel } from "@/components/debug-panel";
import { InterviewReportLoader } from "@/components/interview-report-loader";
import { TranscriptPanel } from "@/components/transcript-panel";
import type { InterviewReport } from "@/lib/interview-report";
import type {
  ConnectionStatus,
  DebugEvent,
  InterviewConfig,
  InterviewPlan,
  TranscriptEntry,
} from "@/lib/types";
import { GPT_LIVE_PRICE_USD_PER_MINUTE } from "@/lib/types";

interface InterviewRoomProps {
  config: InterviewConfig;
  plan: InterviewPlan | null;
  status: ConnectionStatus;
  sessionId: string | null;
  interviewId: string | null;
  report: InterviewReport | null;
  onReportReady: (report: InterviewReport) => void;
  error: string | null;
  elapsedSeconds: number;
  usageSeconds: number | null;
  candidateSpeaking: boolean;
  interviewerSpeaking: boolean;
  muted: boolean;
  mutePending: boolean;
  playbackBlocked: boolean;
  transcript: TranscriptEntry[];
  events: DebugEvent[];
  audioRef: RefObject<HTMLAudioElement | null>;
  onToggleMute: () => void;
  onEnd: () => void;
  onRetry: () => void;
  onBack: () => void;
  onEnableAudio: () => void;
}

const statusLabels: Record<ConnectionStatus, string> = {
  idle: "Ready",
  connecting: "Connecting",
  connected: "Connected",
  ending: "Finishing",
  ended: "Ended",
  error: "Connection issue",
};

export function InterviewRoom({
  config,
  plan,
  status,
  sessionId,
  interviewId,
  report,
  onReportReady,
  error,
  elapsedSeconds,
  usageSeconds,
  candidateSpeaking,
  interviewerSpeaking,
  muted,
  mutePending,
  playbackBlocked,
  transcript,
  events,
  audioRef,
  onToggleMute,
  onEnd,
  onRetry,
  onBack,
  onEnableAudio,
}: InterviewRoomProps) {
  const totalSeconds = config.durationMinutes * 60;
  const progress = Math.min((elapsedSeconds / totalSeconds) * 100, 100);
  const section = currentSection(elapsedSeconds, totalSeconds);
  const canControl = status === "connected";

  return (
    <main className={`room-shell ${status === "ended" ? "room-completed" : ""}`}>
      <audio ref={audioRef} autoPlay playsInline className="remote-audio" />

      <header className="room-header">
        <button className="brand brand-button" type="button" onClick={onBack}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>Live Interview</span>
        </button>

        <div className="room-title">
          <strong>{config.role}</strong>
          <span>
            {config.candidateName} · {capitalize(config.difficulty)} ·{" "}
            {config.mode === "ai-led" ? "AI-led" : "Reviewed plan"}
          </span>
        </div>

        <div className="header-actions">
          <span className={`connection-pill ${status}`}>
            <i /> {statusLabels[status]}
          </span>
          <button
            className="end-button"
            type="button"
            onClick={onEnd}
            disabled={status === "ending" || status === "ended"}
          >
            <StopIcon /> End interview
          </button>
        </div>
      </header>

      {status === "ended" ? <>
        <div className="report-container">
          <InterviewReportLoader key={interviewId} id={interviewId} openaiSessionId={sessionId} transcript={transcript} usageSeconds={usageSeconds} report={report} onReady={onReportReady} />
        </div>
        <details className="completed-transcript"><summary>View full interview transcript <span>{transcript.length} entries</span></summary><TranscriptPanel entries={transcript} isLive={false} /></details>
      </> : <div className="room-layout">
        <section className="conversation-stage">
          <div className="stage-topbar">
            <div>
              <p className="panel-kicker">Current section</p>
              <h1>{section}</h1>
            </div>
            <div className="timer" aria-label={`${formatTime(elapsedSeconds)} elapsed`}>
              <ClockIcon />
              <span>{formatTime(elapsedSeconds)}</span>
              <small>/ {config.durationMinutes}:00</small>
            </div>
          </div>

          <div className="progress-track" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>

          {error && (
            <div className="room-alert" role="alert">
              <AlertIcon />
              <div><strong>Something needs attention</strong><p>{error}</p></div>
              {status === "error" && (
                <button type="button" onClick={onRetry}>Try again</button>
              )}
            </div>
          )}

          {playbackBlocked && (
            <div className="room-alert audio-alert">
              <SpeakerIcon />
              <div><strong>Audio is paused by your browser</strong><p>Enable sound to hear the interviewer.</p></div>
              <button type="button" onClick={onEnableAudio}>Enable sound</button>
            </div>
          )}

          <div className="participants">
            <article className={`participant interviewer ${interviewerSpeaking ? "speaking" : ""}`}>
              <div className="participant-meta">
                <span className="ai-tag">AI interviewer</span>
                <span className="voice-name">{capitalize(config.voice)} voice</span>
              </div>

              <div className="voice-visual">
                <div className="orb-halo halo-one" />
                <div className="orb-halo halo-two" />
                <div className="voice-orb">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>

              <div className="speaking-label">
                <span className="pulse-dot" />
                {status === "connecting"
                  ? "Preparing the room…"
                  : status === "ending"
                    ? "Wrapping up…"
                    : interviewerSpeaking
                      ? "Interviewer is speaking"
                      : status === "connected"
                        ? "Interviewer is listening"
                        : "Waiting to connect"}
              </div>
            </article>

            <article className={`participant candidate ${candidateSpeaking ? "speaking" : ""}`}>
              <div className="candidate-avatar">{initials(config.candidateName)}</div>
              <div className="candidate-info">
                <p className="panel-kicker">Candidate</p>
                <h2>{config.candidateName}</h2>
                <span>
                  <i className={muted ? "muted" : ""} />
                  {muted ? "Microphone muted" : candidateSpeaking ? "Speaking" : "Microphone ready"}
                </span>
              </div>
              <div className="mini-level" aria-hidden="true">
                {[1, 2, 3, 4, 5].map((bar) => <span key={bar} />)}
              </div>
            </article>
          </div>

          <div className="room-controls">
            <button
              className={`control-button ${muted ? "active" : ""}`}
              type="button"
              onClick={onToggleMute}
              disabled={!canControl || mutePending}
              aria-pressed={muted}
            >
              {muted ? <MicOffIcon /> : <MicIcon />}
              <span>{mutePending ? "Updating…" : muted ? "Unmute" : "Mute"}</span>
            </button>
            <p>
              {status === "connected"
                ? "Speak naturally — pauses and interruptions are welcome."
                : status === "connecting"
                  ? "Keep this tab open while the secure audio link starts."
                  : "Use headphones for the clearest conversation."}
            </p>
          </div>
        </section>

        <TranscriptPanel entries={transcript} isLive={status === "connected"} />
      </div>}

      {status === "ended" && (
        <SessionCostSummary
          elapsedSeconds={elapsedSeconds}
          usageSeconds={usageSeconds}
          plan={plan}
          report={report}
        />
      )}

      <div className="room-bottom">
        <div className="session-meta">
          <span>Session</span>
          <code>{sessionId ? compactId(sessionId) : "pending"}</code>
        </div>
        <DebugPanel events={events} />
      </div>
    </main>
  );
}

function SessionCostSummary({
  elapsedSeconds,
  usageSeconds,
  plan,
  report,
}: {
  elapsedSeconds: number;
  usageSeconds: number | null;
  plan: InterviewPlan | null;
  report: InterviewReport | null;
}) {
  const billedSeconds = usageSeconds ?? elapsedSeconds;
  const sessionCost = (billedSeconds / 60) * GPT_LIVE_PRICE_USD_PER_MINUTE;
  const planCost = plan?.generation.estimatedCostUsd ?? 0;
  const reportCost = report?.generation?.estimatedCostUsd ?? 0;
  const totalCost = sessionCost + planCost + reportCost;
  const measured = usageSeconds !== null;

  return (
    <section className="cost-summary" aria-labelledby="cost-summary-title">
      <div className="cost-summary-heading">
        <div>
          <p className="panel-kicker">Session complete</p>
          <h2 id="cost-summary-title">Usage &amp; estimated cost</h2>
        </div>
        <strong>{formatCurrency(totalCost)}</strong>
      </div>

      <div className="cost-breakdown">
        <div>
          <span>{measured ? "Server-metered duration" : "Elapsed duration"}</span>
          <strong>{formatUsageDuration(billedSeconds)}</strong>
        </div>
        <div>
          <span>Live session</span>
          <strong>{formatCurrency(sessionCost)}</strong>
          <small>$0.05 / minute, billed per second</small>
        </div>
        <div>
          <span>Luna question plan</span>
          {plan ? (
            <>
              <strong>{formatCurrency(planCost)}</strong>
              <small>
                {plan.generation.inputTokens.toLocaleString()} input +{" "}
                {plan.generation.outputTokens.toLocaleString()} output tokens
              </small>
            </>
          ) : (
            <>
              <strong>Not used</strong>
              <small>AI-led mode skips plan generation</small>
            </>
          )}
        </div>
        <div>
          <span>Luna interview report</span>
          <strong>{report ? formatCurrency(reportCost) : "Pending report"}</strong>
          <small>{report?.generation ? `${report.generation.inputTokens.toLocaleString()} input + ${report.generation.outputTokens.toLocaleString()} output tokens` : report ? "No model used: no candidate answers" : "Total will include report generation when ready"}</small>
        </div>
      </div>

      <p className="cost-note">
        {measured
          ? "Live cost uses the final server usage event."
          : "Final Live usage was unavailable, so Live cost uses elapsed browser time."}
        {(plan || report?.generation) && " Luna costs use the recorded response tokens."} Your OpenAI
        dashboard remains the billing source of truth.
      </p>
    </section>
  );
}

function currentSection(elapsed: number, total: number) {
  if (elapsed >= total - 60) return "Closing reflections";
  const ratio = elapsed / total;
  if (ratio < 0.18) return "Introductions";
  if (ratio < 0.68) return "Technical depth";
  return "Practical scenario";
}

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;

const formatUsageDuration = (seconds: number) => {
  const wholeSeconds = Math.round(seconds);
  return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
};

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);

const capitalize = (value: string) => value[0].toUpperCase() + value.slice(1);

const initials = (name: string) =>
  name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

const compactId = (id: string) => id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-5)}` : id;

function StopIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg>;
}
function ClockIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>;
}
function AlertIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3 20h18L12 4Z" /><path d="M12 9v5M12 17h.01" /></svg>;
}
function SpeakerIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4ZM17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></svg>;
}
function MicIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" /></svg>;
}
function MicOffIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16M9 9v2a3 3 0 0 0 4.8 2.4M15 10V6a3 3 0 0 0-5.4-1.8M5.5 11a6.5 6.5 0 0 0 10.8 4.9M18.5 11c0 .9-.2 1.7-.5 2.5M12 17.5V21M9 21h6" /></svg>;
}
