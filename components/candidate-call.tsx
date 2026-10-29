"use client";

import styles from "./candidate-room.module.css";
import { Icon, SelfView, useAudioLevel } from "./candidate-presentation";

export type CallNotice = { text: string; action?: { label: string; run: () => void } } | null;

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The interview itself: the interviewer, the candidate's tile and two controls. Text appears only when something needs attention. */
export default function CandidateCall({
  media,
  remote,
  recording,
  remaining,
  connecting,
  finishing,
  muted,
  notice,
  onMute,
  onEnd,
}: {
  media: MediaStream | null;
  remote: MediaStream | null;
  recording: boolean;
  remaining: number | null;
  connecting: boolean;
  finishing: boolean;
  muted: boolean;
  notice: CallNotice;
  onMute: () => void;
  onEnd: () => void;
}) {
  const level = useAudioLevel(finishing ? null : remote, 0.06);
  // Only transitions worth announcing get words; the background shows when the interviewer is talking.
  const status = finishing ? "Ending…" : connecting ? "Connecting…" : "";
  const live = !connecting && !finishing;
  return (
    <main className={styles.call}>
      <header className={styles.callTop}>
        <span aria-label="Time remaining">{remaining !== null && !finishing ? clock(remaining) : ""}</span>
        {recording && (
          <span className={styles.rec}>
            <i aria-hidden="true" />
            Recording
          </span>
        )}
      </header>
      <section className={styles.stage} aria-label="Interview">
        {notice && (
          <div className={styles.notice} role="alert">
            <span>{notice.text}</span>
            {notice.action && <button onClick={notice.action.run}>{notice.action.label}</button>}
          </div>
        )}
        <div
          className={styles.aura}
          aria-hidden="true"
          style={{ opacity: live ? 0.35 + Math.min(1, level * 2.5) * 0.65 : 0.15 }}
        />
        <div className={styles.speaker}>
          <div className={styles.orb}>
            <Icon name="spark" size={48} />
          </div>
          <span className={styles.speakerName} aria-live="polite">
            {status}
          </span>
        </div>
        <div className={styles.selfTile}>
          <SelfView
            stream={media}
            placeholder={
              <span className={styles.avatar}>
                <Icon name="user" size={26} />
              </span>
            }
          />
          <span className={styles.selfName}>
            {muted && <Icon name="micOff" size={14} />}
            You
          </span>
        </div>
      </section>
      <nav className={styles.controls} aria-label="Call controls">
        <button
          className={styles.callButton}
          aria-pressed={muted}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          disabled={connecting || finishing}
          onClick={onMute}
        >
          <Icon name={muted ? "micOff" : "mic"} />
        </button>
        <button
          className={`${styles.callButton} ${styles.hangup}`}
          aria-label="End interview"
          disabled={finishing}
          onClick={onEnd}
        >
          <Icon name="hangup" />
        </button>
      </nav>
    </main>
  );
}
