import type { ReactNode } from "react";
import styles from "./candidate-interview.module.css";

export function CandidateHeader({ children }: { children?: ReactNode }) {
  return (
    <header className={`room-header ${styles.header}`}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>Live Interview</span>
      </div>
      <div className="header-actions">{children}</div>
    </header>
  );
}

export function CandidateGuide({ ready }: { ready: boolean }) {
  return (
    <aside className={styles.guide} aria-label="Interview guide">
      <p className="panel-kicker">A little guidance</p>
      <h2>
        {ready ? "Make yourself comfortable." : "Take your time. Be yourself."}
      </h2>
      <ol className={styles.tips}>
        <li>
          <strong>Find a quiet spot</strong>
          <p>
            Use headphones if you can, and keep this tab open throughout your
            interview.
          </p>
        </li>
        <li>
          <strong>Speak naturally</strong>
          <p>
            Pauses are welcome. You can ask the interviewer to repeat or clarify
            a question.
          </p>
        </li>
        <li>
          <strong>You’re in control</strong>
          <p>Mute your microphone or end the interview whenever you need to.</p>
        </li>
      </ol>
      <div className={styles.privacy}>
        <p className="panel-kicker">Your conversation</p>
        <p>
          Your audio is processed live. A transcript and an AI-generated
          assessment are saved for the recruiter to review.
        </p>
        <p>
          No audio recording is stored by this application. Live captions are
          not available in this room.
        </p>
      </div>
    </aside>
  );
}

export function CandidateOrb({ label }: { label: string }) {
  return (
    <article className="participant interviewer" aria-label="AI interviewer">
      <div className="participant-meta">
        <span className="ai-tag">AI interviewer</span>
        <span className="voice-name">Audio interview</span>
      </div>
      <div className="voice-visual" aria-hidden="true">
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
        <span className="pulse-dot" aria-hidden="true" />
        {label}
      </div>
    </article>
  );
}

export function CandidateClosed({ status }: { status: string }) {
  const completed = status === "completed";
  return (
    <section
      className={`${styles.card} ${styles.closed}`}
      aria-labelledby="closed-title"
    >
      <div className={styles.closedMark} aria-hidden="true">
        {completed ? "✓" : "—"}
      </div>
      <p className="panel-kicker">
        {completed ? "Interview complete" : "Interview closed"}
      </p>
      <h1 id="closed-title">
        {completed ? "Thank you for your time." : "Your interview has closed."}
      </h1>
      <p>
        {completed
          ? "Your conversation has ended. The recruiter will receive the available transcript and results for review."
          : "The recruiter will receive the final status and any available transcript. Contact them if you need help with next steps."}
      </p>
      <div className={styles.nextSteps}>
        <strong>
          {completed ? "What happens next?" : "Need another interview?"}
        </strong>
        <p>
          {completed
            ? "Your recruiter will follow up with you. You can close this tab now."
            : "This room cannot restart the interview. Please ask your recruiter for guidance."}
        </p>
      </div>
    </section>
  );
}
