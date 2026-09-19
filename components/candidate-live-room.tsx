"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./candidate-interview.module.css";
import {
  CandidateClosed,
  CandidateGuide,
  CandidateHeader,
  CandidateOrb,
} from "./candidate-presentation";

export type CandidateSession = {
  job_title: string;
  execution_status: string;
  duration_limit_seconds: number;
  opens_at: string;
  last_start_at: string;
  transport: "sandbox" | "webrtc";
};
async function request(path: string, input?: unknown, signal?: AbortSignal) {
  const response = await fetch(
    path,
    input === undefined
      ? { cache: "no-store", signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          keepalive: path.endsWith("/stop"),
          signal,
        }
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? "Please try again.");
  return result;
}
export default function CandidateLiveRoom({
  session,
  onStatus,
}: {
  session: CandidateSession;
  onStatus: (session: CandidateSession) => void;
}) {
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [ending, setEnding] = useState(false),
    [endPending, setEndPending] = useState(false),
    [muted, setMuted] = useState(false),
    [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [message, setMessage] = useState(""),
    [connected, setConnected] = useState(false),
    [remaining, setRemaining] = useState<number | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null),
    microphone = useRef<MediaStream | null>(null),
    audio = useRef<HTMLAudioElement | null>(null);
  const submitted = useRef(false),
    endRequested = useRef(false),
    alive = useRef(true),
    deadline = useRef<number | null>(null);
  function release() {
    microphone.current?.getTracks().forEach((track) => track.stop());
    microphone.current = null;
    peer.current?.close();
    peer.current = null;
    if (audio.current) audio.current.srcObject = null;
  }
  useEffect(() => {
    alive.current = true;
    const pagehide = () => {
      if (submitted.current)
        void request("/candidate/stop", {}).catch(() => {});
      release();
    };
    window.addEventListener("pagehide", pagehide);
    return () => {
      alive.current = false;
      window.removeEventListener("pagehide", pagehide);
      release();
    };
  }, []);
  useEffect(() => {
    if (!["in_progress", "ready"].includes(session.execution_status)) {
      submitted.current = false;
      release();
    }
  }, [session.execution_status]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (deadline.current)
        setRemaining(
          Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000))
        );
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  async function enableAudio() {
    try {
      await audio.current?.play();
      setPlaybackBlocked(false);
    } catch {
      setPlaybackBlocked(true);
    }
  }
  async function start() {
    if (busy || peer.current || !consent) return;
    setBusy(true);
    setMessage("Checking your microphone…");
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (!alive.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      microphone.current = media;
      const connection = new RTCPeerConnection();
      peer.current = connection;
      media.getTracks().forEach((track) => connection.addTrack(track, media));
      // The service disables frontend provider commands. This channel is never used to submit evidence.
      connection.createDataChannel("oai-events");
      connection.ontrack = (event) => {
        if (audio.current && !endRequested.current) {
          audio.current.srcObject =
            event.streams[0] ?? new MediaStream([event.track]);
          void enableAudio();
        }
      };
      connection.onconnectionstatechange = () => {
        if (!alive.current || endRequested.current) return;
        if (connection.connectionState === "connected") {
          setConnected(true);
          setMessage("Interview in progress.");
        }
        if (["failed", "disconnected"].includes(connection.connectionState)) {
          setConnected(false);
          setMessage(
            "Audio connection interrupted. If it does not recover, end the interview and contact the recruiter."
          );
        }
      };
      await connection.setLocalDescription(await connection.createOffer());
      await new Promise<void>((resolve) => {
        if (connection.iceGatheringState === "complete") return resolve();
        const done = () => {
          clearTimeout(timer);
          connection.removeEventListener("icegatheringstatechange", changed);
          resolve();
        };
        const changed = () => {
          if (connection.iceGatheringState === "complete") done();
        };
        const timer = setTimeout(done, 5000);
        connection.addEventListener("icegatheringstatechange", changed);
      });
      if (!alive.current) return;
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("The audio connection could not be prepared.");
      submitted.current = true;
      onStatus(
        await request("/candidate/start", {
          sdp,
          consent_version: "transcript_v1",
        })
      );
      setMessage("Connecting you to the interviewer…");
      const limit = Date.now() + 45000;
      while (alive.current && Date.now() < limit) {
        const state = await request("/candidate/connection");
        onStatus(state);
        if (state.execution_status !== "in_progress")
          throw new Error(
            "The interview could not continue. Please contact the recruiter."
          );
        if (state.answer) {
          deadline.current = Date.parse(state.deadline_at);
          await connection.setRemoteDescription({
            type: "answer",
            sdp: state.answer,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(
        "The connection took too long. Please contact the recruiter before trying again."
      );
    } catch (error) {
      release();
      if (submitted.current)
        void request("/candidate/stop", {}).catch(() => {});
      if (alive.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "The interview could not start."
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function stop() {
    if (busy) return;
    // Keep WebRTC alive until the provider confirms closure. Disable capture immediately.
    microphone.current?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    audio.current?.pause();
    endRequested.current = true;
    setEndPending(true);
    setEnding(true);
    setConnected(false);
    setBusy(true);
    setMessage("Ending your interview…");
    try {
      const signal = AbortSignal.timeout(15000);
      await request("/candidate/stop", {}, signal);
      while (alive.current && !signal.aborted) {
        const state = await request("/candidate/session", undefined, signal);
        onStatus(state);
        if (state.execution_status !== "in_progress") {
          submitted.current = false;
          setMessage(
            state.execution_status === "completed"
              ? "Interview ended. Your transcript will be processed for the recruiter."
              : "The interview has closed. The recruiter will receive its final status and available transcript."
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (alive.current) throw new Error("End confirmation timed out");
    } catch {
      if (alive.current)
        setMessage(
          "Could not confirm the end request. Your microphone is off. Please retry ending the interview."
        );
    } finally {
      release();
      if (alive.current) {
        setBusy(false);
        setEnding(false);
      }
    }
  }
  const active = session.execution_status === "in_progress";
  const ready = session.execution_status === "ready";
  const closed = !active && !ready;
  const finishing = active && endPending;
  const showTime = active && remaining !== null && !finishing;
  const status = closed
    ? "ended"
    : finishing
    ? "ending"
    : busy
    ? "connecting"
    : connected
    ? "connected"
    : active
    ? "error"
    : "idle";
  const statusLabel = closed
    ? "Closed"
    : finishing
    ? "Ending"
    : busy
    ? "Connecting"
    : connected
    ? "Connected"
    : active
    ? "Connection needed"
    : "Ready";
  const stageTitle = ready
    ? "Before we begin"
    : finishing
    ? "Ending your interview…"
    : remaining === 0
    ? "Time is up. Finishing…"
    : remaining !== null && remaining <= 20
    ? "Wrapping up"
    : "Your conversation";
  return (
    <div className={`room-shell ${styles.room}`}>
      <CandidateHeader>
        <span
          className={`connection-pill ${status} ${styles.status}`}
          role="status"
        >
          <i aria-hidden="true" />
          {statusLabel}
        </span>
        {active && (
          <button
            className={`end-button ${styles.endButton}`}
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("End this interview now?")) void stop();
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="1" />
            </svg>
            {ending ? "Ending…" : "End interview"}
          </button>
        )}
      </CandidateHeader>
      <audio
        ref={audio}
        autoPlay
        playsInline
        aria-label="Interviewer audio"
        className="remote-audio"
      />
      {closed ? (
        <CandidateClosed status={session.execution_status} />
      ) : (
        <div className={`room-layout ${styles.layout}`}>
          <section
            className={`conversation-stage ${styles.stage}`}
            aria-labelledby="stage-title"
          >
            <div className={`stage-topbar ${styles.topbar}`}>
              <div>
                <p className="panel-kicker">
                  {session.duration_limit_seconds / 60} minute audio interview
                </p>
                <h1 id="stage-title">{session.job_title}</h1>
                <p className={styles.stageLabel}>{stageTitle}</p>
              </div>
              {showTime && (
                <div
                  className={`timer ${styles.timer}`}
                  aria-label="Time remaining"
                >
                  <span>
                    {Math.floor(remaining / 60)}:
                    {String(remaining % 60).padStart(2, "0")}
                  </span>
                  <small>remaining</small>
                </div>
              )}
            </div>
            {showTime && (
              <div className="progress-track" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(
                        0,
                        (1 - remaining / session.duration_limit_seconds) * 100
                      )
                    )}%`,
                  }}
                />
              </div>
            )}
            <p className={styles.notice} role="status" aria-live="polite">
              {message}
            </p>
            {playbackBlocked && active && !finishing && (
              <div className={styles.audioAlert} role="alert">
                <p>Your browser has paused the interviewer’s audio.</p>
                <button
                  className={styles.button}
                  onClick={() => void enableAudio()}
                >
                  Enable sound
                </button>
              </div>
            )}
            <div className="participants">
              <CandidateOrb
                label={
                  finishing
                    ? "Wrapping up…"
                    : busy
                    ? "Preparing the room…"
                    : connected
                    ? "Audio connected"
                    : "Waiting to connect"
                }
              />
              <article className="participant candidate">
                <div className="candidate-avatar" aria-hidden="true">
                  You
                </div>
                <div className="candidate-info">
                  <p className="panel-kicker">Candidate</p>
                  <h2>Your space to shine</h2>
                  <span>
                    <i
                      className={
                        !connected || muted || finishing ? "muted" : ""
                      }
                      aria-hidden="true"
                    />
                    {finishing
                      ? "Microphone off"
                      : !connected
                      ? "Microphone not connected"
                      : muted
                      ? "Microphone muted"
                      : "Microphone on"}
                  </span>
                </div>
              </article>
            </div>
            {ready ? (
              <div className={styles.preflight}>
                <p>
                  When you start, your browser will ask for microphone access.
                  Reloading this page cannot restore a live audio connection.
                </p>
                <label className={styles.consent}>
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={busy}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  I agree to live audio processing and to a transcript and
                  AI-generated assessment being saved and shared with the
                  recruiter for review.
                </label>
                <button
                  className={`${styles.button} ${styles.primary}`}
                  disabled={!consent || busy}
                  onClick={() => void start()}
                >
                  {busy ? "Preparing your interview…" : "Start interview"}
                </button>
              </div>
            ) : (
              <>
                {!connected && !busy && !finishing && (
                  <p className={styles.notice}>
                    If this interview is open in another tab, return there.
                    Otherwise, end it and contact the recruiter. Reloading
                    cannot restore the audio connection.
                  </p>
                )}
                <div className="room-controls">
                  <button
                    className={`control-button ${muted ? "active" : ""} ${
                      styles.muteButton
                    }`}
                    disabled={!connected || busy || finishing}
                    aria-pressed={muted}
                    onClick={() => {
                      microphone.current?.getAudioTracks().forEach((track) => {
                        track.enabled = muted;
                      });
                      setMuted(!muted);
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
                      {muted && <path d="m3 3 18 18" />}
                    </svg>
                    {muted ? "Unmute microphone" : "Mute microphone"}
                  </button>
                  <p>
                    {finishing
                      ? "Your microphone is off while we confirm the end."
                      : "Speak naturally — pauses and interruptions are welcome."}
                  </p>
                </div>
              </>
            )}
          </section>
          <CandidateGuide ready={ready} />
        </div>
      )}
    </div>
  );
}
