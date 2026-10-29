"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./candidate-room.module.css";

const paths = {
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  micOff: "M3 3l18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3",
  camera: "M15 10l5-3v10l-5-3M3 7h12v10H3z",
  speaker: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12",
  hangup: "M4 15c4.4-4 11.6-4 16 0l-2 3-3.5-1.5V14a10 10 0 0 0-5 0v2.5L6 18z",
  check: "M5 12l5 5L20 7",
  alert: "M12 8v5M12 16h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  headphones: "M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z",
  tab: "M3 5h18v14H3zM3 9h18",
  quiet: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12h8",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
};
export type IconName = keyof typeof paths;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export function CandidateTopBar({ children }: { children?: ReactNode }) {
  return (
    <header className={styles.topbar}>
      <div className={styles.brand}>
        <span className={styles.brandMark}>
          <Icon name="spark" size={16} />
        </span>
        AI interview
      </div>
      {children}
    </header>
  );
}

/** Shows a live stream, mirrored, or a placeholder until one exists. */
export function SelfView({ stream, placeholder }: { stream: MediaStream | null; placeholder: ReactNode }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const hasVideo = Boolean(stream?.getVideoTracks().length);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = hasVideo && stream ? new MediaStream(stream.getVideoTracks()) : null;
    if (hasVideo) void element.play().catch(() => {});
  }, [stream, hasVideo]);
  return hasVideo ? <video ref={video} autoPlay muted playsInline aria-label="Your camera" /> : <>{placeholder}</>;
}

/** Loudness of a stream from 0 to 1, sampled about 15 times a second. */
export function useAudioLevel(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream?.getAudioTracks().length) return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      if (time - last < 66) return;
      last = time;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    };
    void context.resume().catch(() => {});
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setLevel(0);
      void context.close().catch(() => {});
    };
  }, [stream]);
  return level;
}

export function CandidateDone({ status, note }: { status: string; note?: string }) {
  const completed = status === "completed";
  return (
    <main className={styles.page}>
      <CandidateTopBar />
      <div className={styles.center}>
        <section className={`${styles.card} ${styles.narrow}`} aria-labelledby="done-title">
          <div className={`${styles.done} ${completed ? "" : styles.closed}`}>
            <Icon name={completed ? "check" : "alert"} size={26} />
          </div>
          <h1 id="done-title" className={styles.title}>
            {completed ? "Thanks, you’re all done" : "This interview has closed"}
          </h1>
          <p className={styles.sub}>
            {completed
              ? "You can close this tab. The recruiter will follow up with you."
              : "It can’t be restarted from here. Contact the recruiter if you need help."}
          </p>
          {note && (
            <p className={styles.info} role="status" aria-live="polite">
              {note}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
