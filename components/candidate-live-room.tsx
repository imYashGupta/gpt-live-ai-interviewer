"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CandidateCall, { type CallNotice } from "./candidate-call";
import { CandidateDone } from "./candidate-presentation";
import CandidateSetup from "./candidate-setup";
import { InterviewRecorder, type RecorderState } from "./interview-recorder";
import { IntegrityLog } from "./integrity-log";

export type CandidateSession = {
  job_title: string;
  execution_status: string;
  duration_limit_seconds: number;
  opens_at: string;
  last_start_at: string;
  transport: "sandbox" | "webrtc";
  recording_required?: boolean;
};
// Small enough for a candidate's upload link while the live audio runs; the recorder adds its own bitrate cap.
const cameraConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 15, max: 24 },
  facingMode: "user",
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
  const recording = session.recording_required === true;
  const [consent, setConsent] = useState(false),
    [recordingConsent, setRecordingConsent] = useState(false),
    [media, setMedia] = useState<MediaStream | null>(null),
    [mediaError, setMediaError] = useState(""),
    [preparing, setPreparing] = useState(false),
    [remote, setRemote] = useState<MediaStream | null>(null),
    [cameraLost, setCameraLost] = useState(false),
    [recorderState, setRecorderState] = useState<RecorderState | null>(null),
    [recordingProblem, setRecordingProblem] = useState(false),
    [busy, setBusy] = useState(false),
    [endPending, setEndPending] = useState(false),
    [muted, setMuted] = useState(false),
    [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [error, setError] = useState(""),
    [connected, setConnected] = useState(false),
    [remaining, setRemaining] = useState<number | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null),
    microphone = useRef<MediaStream | null>(null),
    audio = useRef<HTMLAudioElement | null>(null),
    recorder = useRef<InterviewRecorder | null>(null),
    integrity = useRef<IntegrityLog | null>(null),
    remoteStream = useRef<MediaStream | null>(null);
  const submitted = useRef(false),
    endRequested = useRef(false),
    alive = useRef(true),
    deadline = useRef<number | null>(null);
  function release() {
    // Stop the recorder before its tracks so the final chunk is captured; its uploads continue afterwards.
    void recorder.current?.stop();
    integrity.current?.stop();
    microphone.current?.getTracks().forEach((track) => track.stop());
    microphone.current = null;
    peer.current?.close();
    peer.current = null;
    if (audio.current) audio.current.srcObject = null;
  }
  useEffect(() => {
    alive.current = true;
    const pagehide = () => {
      recorder.current?.abandon();
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
  const uploadsPending = (recorderState?.pending ?? 0) > 0;
  useEffect(() => {
    if (!uploadsPending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadsPending]);
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
  /** Opens the microphone (and camera when recording) for the setup check; the interview reuses the same stream. */
  async function openDevices() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: recording ? cameraConstraints : false,
    });
    if (!alive.current) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("The page closed.");
    }
    const video = stream.getVideoTracks()[0];
    if (recording && (!video || video.readyState !== "live")) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        "Your camera didn’t start. Check no other app is using it, then try again."
      );
    }
    video?.addEventListener("ended", () => {
      if (!alive.current || endRequested.current) return;
      setCameraLost(true);
      integrity.current?.add("camera_lost");
    });
    microphone.current?.getTracks().forEach((track) => track.stop());
    microphone.current = stream;
    setMedia(stream);
    return stream;
  }
  const prepareMedia = useCallback(async () => {
    setPreparing(true);
    setMediaError("");
    try {
      await openDevices();
    } catch (error) {
      setMediaError(
        error instanceof Error && error.message.startsWith("Your camera")
          ? error.message
          : recording
          ? "Allow camera and microphone access in your browser’s address bar, then try again."
          : "Allow microphone access in your browser’s address bar, then try again."
      );
    } finally {
      if (alive.current) setPreparing(false);
    }
    // openDevices only reads refs and the recording flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);
  /** A recording failure does not stop the interview; the recruiter sees which parts are missing. */
  async function startRecording(stream: MediaStream) {
    const video = stream.getVideoTracks()[0];
    const instance = new InterviewRecorder(video, stream, (state) => {
      if (alive.current) setRecorderState(state);
    });
    try {
      await instance.start();
      recorder.current = instance;
      if (remoteStream.current) instance.addRemoteAudio(remoteStream.current);
    } catch {
      void instance.stop();
      integrity.current?.add("recording_unavailable");
      setRecordingProblem(true);
    }
  }
  async function start() {
    if (busy || peer.current || !consent || (recording && !recordingConsent))
      return;
    setBusy(true);
    setError("");
    try {
      const current = microphone.current;
      const stream =
        current && current.getTracks().every((track) => track.readyState === "live")
          ? current
          : await openDevices().catch(() => {
              throw new Error(
                recording
                  ? "This interview needs your camera and microphone. Allow access in your browser, then try again."
                  : "This interview needs your microphone. Allow access in your browser, then try again."
              );
            });
      const connection = new RTCPeerConnection();
      peer.current = connection;
      // The interviewer receives audio only; the camera is used for the recording.
      stream
        .getAudioTracks()
        .forEach((track) => connection.addTrack(track, stream));
      // The service disables frontend provider commands. This channel is never used to submit evidence.
      connection.createDataChannel("oai-events");
      connection.ontrack = (event) => {
        if (audio.current && !endRequested.current) {
          const remoteAudio = event.streams[0] ?? new MediaStream([event.track]);
          audio.current.srcObject = remoteAudio;
          remoteStream.current = remoteAudio;
          setRemote(remoteAudio);
          recorder.current?.addRemoteAudio(remoteAudio);
          void enableAudio();
        }
      };
      connection.onconnectionstatechange = () => {
        if (!alive.current || endRequested.current) return;
        if (connection.connectionState === "connected") setConnected(true);
        if (["failed", "disconnected"].includes(connection.connectionState))
          setConnected(false);
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
      if (!sdp) throw new Error("The audio connection couldn’t be prepared.");
      submitted.current = true;
      onStatus(
        await request("/candidate/start", {
          sdp,
          consent_version: "transcript_v1",
        })
      );
      integrity.current = new IntegrityLog();
      if (recording) await startRecording(stream);
      const limit = Date.now() + 45000;
      while (alive.current && Date.now() < limit) {
        const state = await request("/candidate/connection");
        onStatus(state);
        if (state.execution_status !== "in_progress")
          throw new Error(
            "The interview couldn’t continue. Contact the recruiter."
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
        "The connection took too long. Contact the recruiter before trying again."
      );
    } catch (error) {
      release();
      setMedia(null);
      if (submitted.current)
        void request("/candidate/stop", {}).catch(() => {});
      if (alive.current)
        setError(
          error instanceof Error
            ? error.message
            : "The interview couldn’t start."
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
    setConnected(false);
    setBusy(true);
    setError("");
    try {
      const signal = AbortSignal.timeout(15000);
      await request("/candidate/stop", {}, signal);
      while (alive.current && !signal.aborted) {
        const state = await request("/candidate/session", undefined, signal);
        onStatus(state);
        if (state.execution_status !== "in_progress") {
          submitted.current = false;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (alive.current) throw new Error("End confirmation timed out");
    } catch {
      if (alive.current) {
        setEndPending(false);
        setError(
          "We couldn’t confirm the interview ended. Your microphone is off."
        );
      }
    } finally {
      release();
      if (alive.current) setBusy(false);
    }
  }
  function toggleMute() {
    microphone.current?.getAudioTracks().forEach((track) => {
      track.enabled = muted;
    });
    setMuted(!muted);
  }

  const active = session.execution_status === "in_progress";
  const ready = session.execution_status === "ready";
  const finishing = active && endPending;
  // One notice at a time, most urgent first; the call screen is otherwise text-free.
  const notice: CallNotice = !active
    ? null
    : error
    ? { text: error, action: { label: "End interview", run: () => void stop() } }
    : playbackBlocked && !finishing
    ? { text: "Your browser paused the interviewer’s audio.", action: { label: "Turn on sound", run: () => void enableAudio() } }
    : !connected && !busy && !finishing
    ? remote
      ? { text: "Connection lost. Reconnecting…" }
      : { text: "This interview is open in another tab, or the connection was lost. Return to that tab or end the interview.", action: { label: "End interview", run: () => void stop() } }
    : cameraLost && !finishing
    ? { text: "Your camera stopped. Reconnect it; the recruiter will see the gap in the video." }
    : recordingProblem && !finishing
    ? { text: "Your video isn’t being recorded. The interview continues." }
    : null;

  return (
    <>
      <audio ref={audio} autoPlay playsInline aria-label="Interviewer audio" hidden />
      {ready ? (
        <CandidateSetup
          session={session}
          recording={recording}
          consent={consent}
          onConsent={setConsent}
          recordingConsent={recordingConsent}
          onRecordingConsent={setRecordingConsent}
          media={media}
          mediaError={mediaError}
          preparing={preparing}
          onPrepareMedia={prepareMedia}
          busy={busy}
          error={error}
          onStart={() => void start()}
        />
      ) : active ? (
        <CandidateCall
          media={media}
          remote={remote}
          recording={recording && Boolean(recorderState) && recorderState?.status === "recording"}
          remaining={remaining}
          connecting={busy && !finishing}
          finishing={finishing}
          muted={muted}
          notice={notice}
          onMute={toggleMute}
          onEnd={() => {
            if (window.confirm("End this interview now?")) void stop();
          }}
        />
      ) : (
        <CandidateDone
          status={session.execution_status}
          note={
            uploadsPending
              ? "Saving your video recording… Keep this tab open until this message disappears."
              : undefined
          }
        />
      )}
    </>
  );
}
