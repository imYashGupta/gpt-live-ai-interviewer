"use client";

import { useEffect, useState } from "react";
import styles from "./candidate-room.module.css";
import { CandidateTopBar, Icon, SelfView, useAudioLevel, type IconName } from "./candidate-presentation";
import type { CandidateSession } from "./candidate-live-room";

const stepNames = ["What to expect", "Consent", "Camera and microphone", "Speaker"] as const;

/** A short rising tone, generated locally so the speaker check needs no audio file. */
async function playTestSound() {
  const context = new AudioContext();
  await context.resume().catch(() => {});
  const tone = context.createOscillator();
  const gain = context.createGain();
  tone.frequency.setValueAtTime(523, context.currentTime);
  tone.frequency.setValueAtTime(659, context.currentTime + 0.25);
  tone.frequency.setValueAtTime(784, context.currentTime + 0.5);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.8);
  tone.connect(gain).connect(context.destination);
  tone.start();
  tone.stop(context.currentTime + 0.85);
  tone.onended = () => void context.close().catch(() => {});
}

function Steps({ current }: { current: number }) {
  return (
    <div className={styles.steps} aria-label={`Step ${current + 1} of ${stepNames.length}: ${stepNames[current]}`}>
      {stepNames.map((name, index) => (
        <span key={name} className={styles.stepBar} data-done={index <= current} aria-hidden="true" />
      ))}
      <span className={styles.stepLabel} aria-hidden="true">
        Step {current + 1} of {stepNames.length} · {stepNames[current]}
      </span>
    </div>
  );
}

function Tip({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <li className={styles.listItem}>
      <span className={styles.listIcon}>
        <Icon name={icon} size={18} />
      </span>
      <span>
        {title}
        <small>{detail}</small>
      </span>
    </li>
  );
}

export default function CandidateSetup({
  session,
  recording,
  consent,
  onConsent,
  recordingConsent,
  onRecordingConsent,
  media,
  mediaError,
  preparing,
  onPrepareMedia,
  busy,
  error,
  onStart,
}: {
  session: CandidateSession;
  recording: boolean;
  consent: boolean;
  onConsent: (value: boolean) => void;
  recordingConsent: boolean;
  onRecordingConsent: (value: boolean) => void;
  media: MediaStream | null;
  mediaError: string;
  preparing: boolean;
  onPrepareMedia: () => void;
  busy: boolean;
  error: string;
  onStart: () => void;
}) {
  const [step, setStep] = useState(0);
  const [heard, setHeard] = useState(false);
  const [soundPlayed, setSoundPlayed] = useState(false);
  const level = useAudioLevel(step === 2 ? media : null);
  const minutes = Math.round(session.duration_limit_seconds / 60);
  const consented = consent && (!recording || recordingConsent);
  // Devices are opened only after consent, when the candidate reaches the check.
  useEffect(() => {
    if (step === 2 && !media && !preparing && !mediaError) onPrepareMedia();
  }, [step, media, preparing, mediaError, onPrepareMedia]);
  // Latches once the candidate has been heard; adjusting state while rendering avoids an extra effect pass.
  if (level > 0.15 && !heard) setHeard(true);
  const cameraOk = !recording || Boolean(media?.getVideoTracks().some((track) => track.readyState === "live"));
  const micOk = Boolean(media?.getAudioTracks().length);

  if (step === 4) {
    return (
      <main className={styles.page}>
        <CandidateTopBar />
        <div className={styles.center}>
          <section className={`${styles.card} ${styles.split}`} aria-labelledby="join-title">
            <div className={styles.preview}>
              <SelfView stream={media} placeholder={<Icon name="mic" size={40} />} />
            </div>
            <div className={styles.join}>
              <h1 id="join-title" className={styles.title}>
                Ready to start?
              </h1>
              <p className={styles.joinMeta}>
                {session.job_title} · {minutes} min
              </p>
              <div className={styles.actions}>
                <button className={styles.button} disabled={busy} onClick={() => setStep(3)}>
                  Back
                </button>
                <button className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={onStart}>
                  {busy ? "Connecting…" : "Start interview"}
                </button>
              </div>
              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <CandidateTopBar />
      <div className={styles.center}>
        <section className={styles.card} aria-labelledby="setup-title">
          <Steps current={step} />
          {step === 0 && (
            <>
              <h1 id="setup-title" className={styles.title}>
                {session.job_title}
              </h1>
              <p className={styles.sub}>
                A {minutes}-minute {recording ? "video" : "voice"} interview. An AI interviewer asks the questions, not a
                person. Here’s what helps.
              </p>
              <ul className={styles.list}>
                <Tip icon="quiet" title="Find a quiet place" detail="Background noise makes it harder to hear you." />
                <Tip icon="headphones" title="Use headphones if you can" detail="They stop the interviewer hearing itself." />
                <Tip icon="tab" title="Keep this tab open" detail="Reloading or closing it ends the interview." />
                <Tip icon="clock" title={`Set aside ${minutes} minutes`} detail="Pauses are fine. You can ask for a question again." />
              </ul>
              <div className={styles.actions}>
                <button className={`${styles.button} ${styles.primary}`} onClick={() => setStep(1)}>
                  Next
                </button>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <h1 id="setup-title" className={styles.title}>
                Before you start
              </h1>
              <p className={styles.sub}>The recruiter reviews what’s saved from this interview.</p>
              <label className={styles.check} data-checked={consent}>
                <input type="checkbox" checked={consent} onChange={(e) => onConsent(e.target.checked)} />
                <span>
                  I agree to live audio processing and to a transcript and AI-generated assessment being saved and
                  shared with the recruiter for review.
                </span>
              </label>
              {recording && (
                <label className={styles.check} data-checked={recordingConsent}>
                  <input
                    type="checkbox"
                    checked={recordingConsent}
                    onChange={(e) => onRecordingConsent(e.target.checked)}
                  />
                  <span>
                    I agree to my camera and microphone being video recorded for the whole interview, together with the
                    interviewer’s voice, and to the recording being stored and shared with the recruiter for review.
                  </span>
                </label>
              )}
              <div className={styles.actions}>
                <button className={styles.button} onClick={() => setStep(0)}>
                  Back
                </button>
                <button className={`${styles.button} ${styles.primary}`} disabled={!consented} onClick={() => setStep(2)}>
                  Next
                </button>
              </div>
            </>
          )}
          {step === 2 && (
            <div className={styles.split}>
              <div className={styles.preview}>
                <SelfView
                  stream={media}
                  placeholder={
                    <span className={styles.previewLabel}>
                      {preparing ? "Starting your camera…" : recording ? "Camera off" : <Icon name="mic" size={40} />}
                    </span>
                  }
                />
              </div>
              <div>
                <h1 id="setup-title" className={styles.title}>
                  {recording ? "Can we see and hear you?" : "Can we hear you?"}
                </h1>
                {recording && (
                  <p className={styles.status}>
                    <span className={cameraOk && media ? styles.ok : styles.bad}>
                      <Icon name={cameraOk && media ? "check" : "camera"} size={20} />
                    </span>
                    {cameraOk && media ? "Camera working" : "Waiting for your camera"}
                  </p>
                )}
                <p className={styles.status}>
                  <span className={heard ? styles.ok : undefined}>
                    <Icon name={heard ? "check" : "mic"} size={20} />
                  </span>
                  {heard ? "We can hear you" : micOk ? "Say something" : "Waiting for your microphone"}
                </p>
                <div className={styles.meter} aria-hidden="true">
                  {[0.08, 0.2, 0.35, 0.5, 0.7].map((threshold) => (
                    <span key={threshold} data-on={level > threshold} />
                  ))}
                </div>
                {mediaError && (
                  <div className={styles.error} role="alert">
                    {mediaError}
                  </div>
                )}
                <div className={styles.actions}>
                  <button className={styles.button} onClick={() => setStep(1)}>
                    Back
                  </button>
                  {mediaError ? (
                    <button className={`${styles.button} ${styles.primary}`} onClick={onPrepareMedia}>
                      Try again
                    </button>
                  ) : (
                    <button
                      className={`${styles.button} ${styles.primary}`}
                      disabled={!media || !cameraOk}
                      onClick={() => setStep(3)}
                    >
                      Next
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {step === 3 && (
            <>
              <h1 id="setup-title" className={styles.title}>
                Can you hear us?
              </h1>
              <p className={styles.sub}>Play the test sound. Turn your volume up if it’s too quiet.</p>
              <div className={styles.actions}>
                <button
                  className={styles.button}
                  onClick={() => {
                    setSoundPlayed(true);
                    void playTestSound();
                  }}
                >
                  <Icon name="speaker" size={18} />
                  Play test sound
                </button>
              </div>
              <div className={styles.actions}>
                <button className={styles.button} onClick={() => setStep(2)}>
                  Back
                </button>
                <button className={`${styles.button} ${styles.primary}`} disabled={!soundPlayed} onClick={() => setStep(4)}>
                  I heard it
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
