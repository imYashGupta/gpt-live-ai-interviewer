"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./candidate-interview.module.css";

export type CandidateSession = {
  job_title: string;
  execution_status: string;
  duration_limit_seconds: number;
  opens_at: string;
  last_start_at: string;
  transport: "sandbox" | "webrtc";
};
async function request(path: string, input?: unknown) {
  const response = await fetch(
    path,
    input === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          keepalive: path.endsWith("/stop"),
        }
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? "Please try again.");
  return result;
}
const button = styles.button;
export default function CandidateLiveRoom({
  session,
  onStatus,
}: {
  session: CandidateSession;
  onStatus: (session: CandidateSession) => void;
}) {
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [muted, setMuted] = useState(false);
  const [message, setMessage] = useState(""),
    [connected, setConnected] = useState(false),
    [remaining, setRemaining] = useState<number | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null),
    microphone = useRef<MediaStream | null>(null),
    audio = useRef<HTMLAudioElement | null>(null);
  const submitted = useRef(false),
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
        if (audio.current) {
          audio.current.srcObject =
            event.streams[0] ?? new MediaStream([event.track]);
          void audio.current
            .play()
            .catch(() =>
              setMessage("Press play below to hear the interviewer.")
            );
        }
      };
      connection.onconnectionstatechange = () => {
        if (!alive.current) return;
        if (connection.connectionState === "connected") {
          setConnected(true);
          setMessage("Interview in progress.");
        }
        if (["failed", "disconnected"].includes(connection.connectionState))
          setMessage(
            "Audio connection interrupted. If it does not recover, end the interview and contact the recruiter."
          );
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
    release();
    setConnected(false);
    setBusy(true);
    try {
      await request("/candidate/stop", {});
      setMessage(
        "Interview ended. Your transcript will be processed for the recruiter."
      );
      submitted.current = false;
    } catch {
      setMessage(
        "Could not confirm the end request. Your microphone is off. Please retry ending the interview."
      );
    } finally {
      setBusy(false);
    }
  }
  const active = session.execution_status === "in_progress";
  return (
    <section className={styles.card}>
      <h2>{session.job_title}</h2>
      <p>{session.duration_limit_seconds / 60} minute audio interview</p>
      <p>Status: {session.execution_status.replaceAll("_", " ")}</p>
      {session.execution_status === "ready" && (
        <>
          <p>
            Your microphone audio is processed live. A transcript and an
            AI-generated assessment will be saved and shared with the recruiter
            for review. You can mute or end the interview at any time.
          </p>
          <p>
            No audio recording is stored by this application. Keep this tab open
            during the interview; reloading cannot restore the audio connection.
          </p>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(e) => setConsent(e.target.checked)}
            />
            I agree to the audio processing and transcript-based assessment
            described above.
          </label>
          <button
            className={`${button} ${styles.primary}`}
            disabled={!consent || busy}
            onClick={() => void start()}
          >
            Start interview
          </button>
        </>
      )}
      <audio
        ref={audio}
        autoPlay
        controls
        aria-label="Interviewer audio"
        className={styles.audio}
        hidden={!active}
      />
      {active && (
        <>
          {remaining !== null && (
            <p>
              Time remaining: {Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, "0")}
            </p>
          )}
          {!connected && !busy && (
            <p>
              If this interview is open in another tab, return there. Otherwise,
              end it and contact the recruiter.
            </p>
          )}
          <div className={styles.actions}>
            <button
              className={button}
              disabled={!connected}
              onClick={() => {
                microphone.current?.getAudioTracks().forEach((t) => {
                  t.enabled = muted;
                });
                setMuted(!muted);
              }}
            >
              {muted ? "Unmute microphone" : "Mute microphone"}
            </button>
            <button
              className={button}
              disabled={busy}
              onClick={() => {
                if (window.confirm("End this interview now?")) void stop();
              }}
            >
              End interview
            </button>
          </div>
        </>
      )}
      {!active && session.execution_status !== "ready" && (
        <p>
          Your interview has ended. The recruiter will receive the available
          transcript and results.
        </p>
      )}
      <p className={styles.message} role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
