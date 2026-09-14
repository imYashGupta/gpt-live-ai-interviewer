"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { InterviewRoom } from "@/components/interview-room";
import { InterviewSetup } from "@/components/interview-setup";
import type {
  ConnectionStatus,
  DebugEvent,
  InterviewConfig,
  LiveSessionResponse,
  TranscriptEntry,
} from "@/lib/types";

const ICE_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 15_000;
const MAX_DEBUG_EVENTS = 120;

type LiveMessage = Record<string, unknown> & { type?: string };

export function InterviewApp() {
  const [roomOpen, setRoomOpen] = useState(false);
  const [config, setConfig] = useState<InterviewConfig | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [muted, setMuted] = useState(false);
  const [mutePending, setMutePending] = useState(false);
  const [candidateSpeaking, setCandidateSpeaking] = useState(false);
  const [interviewerSpeaking, setInterviewerSpeaking] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [usageSeconds, setUsageSeconds] = useState<number | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const monitorStopsRef = useRef<Array<() => void>>([]);
  const startTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const finalizingRef = useRef(false);
  const statusRef = useRef<ConnectionStatus>("idle");

  const updateStatus = useCallback((nextStatus: ConnectionStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const cleanupResources = useCallback(() => {
    if (startTimeoutRef.current) clearTimeout(startTimeoutRef.current);
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    startTimeoutRef.current = null;
    closeTimeoutRef.current = null;

    for (const stop of monitorStopsRef.current) stop();
    monitorStopsRef.current = [];
    setCandidateSpeaking(false);
    setInterviewerSpeaking(false);

    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    startedAtRef.current = null;
  }, []);

  useEffect(() => cleanupResources, [cleanupResources]);

  const addDebugEvent = useCallback(
    (direction: DebugEvent["direction"], event: Record<string, unknown>) => {
      const item: DebugEvent = {
        id: makeId(),
        receivedAt: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        direction,
        event,
      };
      setEvents((current) => [...current, item].slice(-MAX_DEBUG_EVENTS));
    },
    [],
  );

  const sendEvent = useCallback(
    (event: Record<string, unknown>) => {
      const channel = channelRef.current;
      if (!channel || channel.readyState !== "open") return false;
      channel.send(JSON.stringify(event));
      addDebugEvent("out", event);
      return true;
    },
    [addDebugEvent],
  );

  const addTranscriptDelta = useCallback(
    (speaker: TranscriptEntry["speaker"], event: LiveMessage) => {
      if (
        typeof event.delta !== "string" ||
        typeof event.start_ms !== "number" ||
        typeof event.end_ms !== "number"
      ) return;

      const delta = event.delta;
      const startMs = event.start_ms;
      const endMs = event.end_ms;

      setTranscript((current) => {
        let previousIndex = -1;
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (current[index].speaker === speaker) {
            previousIndex = index;
            break;
          }
        }

        const previous = current[previousIndex];
        if (previous && startMs <= previous.endMs + 1_400) {
          return current.map((entry, index) =>
            index === previousIndex
              ? {
                  ...entry,
                  text: entry.text + delta,
                  endMs: Math.max(entry.endMs, endMs),
                }
              : entry,
          );
        }

        return [
          ...current,
          {
            id: makeId(),
            speaker,
            text: delta,
            startMs,
            endMs,
          },
        ];
      });
    },
    [],
  );

  const handleServerEvent = useCallback(
    (event: LiveMessage) => {
      addDebugEvent("in", event);

      switch (event.type) {
        case "session.started": {
          if (startTimeoutRef.current) clearTimeout(startTimeoutRef.current);
          startTimeoutRef.current = null;
          const session = event.session as Record<string, unknown> | undefined;
          if (typeof session?.id === "string") setSessionId(session.id);
          startedAtRef.current = performance.now();
          updateStatus("connected");
          setError(null);
          sendEvent({
            type: "session.commentary.append",
            event_id: `begin_${Date.now()}`,
            delegation_id: null,
            content: "Begin the interview now with the brief welcome, then pause and listen.",
          });
          break;
        }
        case "session.input_transcript.delta":
          addTranscriptDelta("candidate", event);
          break;
        case "session.output_transcript.delta":
          addTranscriptDelta("interviewer", event);
          break;
        case "session.input_audio.muted":
          setMuted(true);
          setMutePending(false);
          break;
        case "session.input_audio.unmuted":
          setMuted(false);
          setMutePending(false);
          break;
        case "session.usage.updated": {
          const usage = event.usage as Record<string, unknown> | undefined;
          if (typeof usage?.seconds === "number") {
            setUsageSeconds(Math.max(0, usage.seconds));
          }
          break;
        }
        case "session.closed": {
          const usage = event.usage as Record<string, unknown> | undefined;
          if (typeof usage?.seconds === "number") {
            setUsageSeconds(Math.max(0, usage.seconds));
          }
          finalizingRef.current = true;
          updateStatus("ended");
          cleanupResources();
          break;
        }
        case "error": {
          const liveError = event.error as Record<string, unknown> | undefined;
          const message =
            typeof liveError?.message === "string"
              ? liveError.message
              : "The Live session reported an error.";
          setError(message);
          setMutePending(false);
          break;
        }
      }
    },
    [addDebugEvent, addTranscriptDelta, cleanupResources, sendEvent, updateStatus],
  );

  const connect = useCallback(
    async (interviewConfig: InterviewConfig) => {
      cleanupResources();
      finalizingRef.current = false;
      updateStatus("connecting");
      setError(null);
      setSessionId(null);
      setTranscript([]);
      setEvents([]);
      setMuted(false);
      setMutePending(false);
      setElapsedSeconds(0);
      setUsageSeconds(null);
      setPlaybackBlocked(false);

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser does not support microphone capture.");
        }

        const peer = new RTCPeerConnection();
        peerRef.current = peer;

        peer.addEventListener("track", (event) => {
          const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
          if (audioRef.current) {
            audioRef.current.srcObject = remoteStream;
            audioRef.current.play().then(
              () => setPlaybackBlocked(false),
              () => setPlaybackBlocked(true),
            );
          }
          startMonitor(remoteStream, setInterviewerSpeaking, 0.018)
            .then((stop) => monitorStopsRef.current.push(stop))
            .catch(() => undefined);
        });

        peer.addEventListener("connectionstatechange", () => {
          if (peer.connectionState === "failed") {
            setError("The peer-to-peer audio connection failed. Please try again.");
            updateStatus("error");
            cleanupResources();
          }
        });

        const microphone = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        microphoneRef.current = microphone;
        for (const track of microphone.getAudioTracks()) {
          peer.addTrack(track, microphone);
        }

        startMonitor(microphone, setCandidateSpeaking, 0.026)
          .then((stop) => monitorStopsRef.current.push(stop))
          .catch(() => undefined);

        const channel = peer.createDataChannel("oai-events");
        channelRef.current = channel;
        channel.addEventListener("message", ({ data }) => {
          if (typeof data !== "string") return;
          try {
            const event = JSON.parse(data) as LiveMessage;
            if (event && typeof event === "object") handleServerEvent(event);
          } catch {
            setError("A malformed event was received from the Live session.");
          }
        });
        channel.addEventListener("close", () => {
          if (finalizingRef.current || statusRef.current === "ended") return;
          if (statusRef.current === "ending") return;
          setError("The Live event channel closed unexpectedly.");
          updateStatus("error");
          cleanupResources();
        });

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGathering(peer, ICE_TIMEOUT_MS);

        const sdp = peer.localDescription?.sdp;
        if (!sdp) throw new Error("The browser did not create an SDP offer.");

        const response = await fetch("/api/live/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdp, interview: interviewConfig }),
        });
        const result = (await response.json().catch(() => null)) as
          | LiveSessionResponse
          | { error?: string }
          | null;

        if (!response.ok) {
          throw new Error(
            result && "error" in result && result.error
              ? result.error
              : "The server could not create the interview session.",
          );
        }
        if (
          !result ||
          !("session" in result) ||
          typeof result.session?.id !== "string" ||
          !("transport" in result) ||
          typeof result.transport?.sdp !== "string"
        ) {
          throw new Error("The server returned an invalid Live session response.");
        }

        setSessionId(result.session.id);
        await peer.setRemoteDescription({
          type: "answer",
          sdp: result.transport.sdp,
        });

        if (statusRef.current === "connecting") {
          startTimeoutRef.current = setTimeout(() => {
            setError("The Live session did not finish starting. Please try again.");
            updateStatus("error");
            cleanupResources();
          }, START_TIMEOUT_MS);
        }
      } catch (connectionError) {
        let message = "The interview could not be started.";
        if (connectionError instanceof DOMException) {
          if (connectionError.name === "NotAllowedError") {
            message = "Microphone access was denied. Allow access in your browser and try again.";
          } else if (connectionError.name === "NotFoundError") {
            message = "No microphone was found on this device.";
          } else {
            message = connectionError.message || message;
          }
        } else if (connectionError instanceof Error) {
          message = connectionError.message;
        }
        setError(message);
        updateStatus("error");
        cleanupResources();
      }
    },
    [cleanupResources, handleServerEvent, updateStatus],
  );

  const startInterview = useCallback(
    (nextConfig: InterviewConfig) => {
      setConfig(nextConfig);
      setRoomOpen(true);
      void connect(nextConfig);
    },
    [connect],
  );

  const endInterview = useCallback(() => {
    if (statusRef.current === "ending" || statusRef.current === "ended") return;

    const channel = channelRef.current;
    if (statusRef.current === "connected" && channel?.readyState === "open") {
      finalizingRef.current = true;
      updateStatus("ending");
      sendEvent({ type: "session.close", event_id: `close_${Date.now()}` });
      closeTimeoutRef.current = setTimeout(() => {
        setError("The session ended without final usage confirmation.");
        updateStatus("ended");
        cleanupResources();
      }, CLOSE_TIMEOUT_MS);
      return;
    }

    finalizingRef.current = true;
    updateStatus("ended");
    cleanupResources();
  }, [cleanupResources, sendEvent, updateStatus]);

  useEffect(() => {
    if (status !== "connected" || !startedAtRef.current) return;
    const timer = window.setInterval(() => {
      if (!startedAtRef.current) return;
      setElapsedSeconds(Math.floor((performance.now() - startedAtRef.current) / 1_000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (
      status === "connected" &&
      config &&
      elapsedSeconds >= config.durationMinutes * 60
    ) endInterview();
  }, [config, elapsedSeconds, endInterview, status]);

  const toggleMute = useCallback(() => {
    if (statusRef.current !== "connected" || mutePending) return;
    const nextMuted = !muted;
    const tracks = microphoneRef.current?.getAudioTracks() ?? [];
    for (const track of tracks) track.enabled = !nextMuted;
    setMutePending(true);

    const sent = sendEvent({
      type: nextMuted ? "session.input_audio.mute" : "session.input_audio.unmute",
      event_id: `${nextMuted ? "mute" : "unmute"}_${Date.now()}`,
    });
    if (!sent) {
      for (const track of tracks) track.enabled = muted;
      setMutePending(false);
      setError("The microphone command could not be sent.");
    }
  }, [mutePending, muted, sendEvent]);

  const returnToSetup = useCallback(() => {
    if (statusRef.current === "connected" || statusRef.current === "ending") {
      endInterview();
    } else {
      cleanupResources();
    }
    setRoomOpen(false);
  }, [cleanupResources, endInterview]);

  if (!roomOpen || !config) {
    return <InterviewSetup initialConfig={config ?? undefined} onStart={startInterview} />;
  }

  return (
    <InterviewRoom
      config={config}
      status={status}
      sessionId={sessionId}
      error={error}
      elapsedSeconds={elapsedSeconds}
      usageSeconds={usageSeconds}
      candidateSpeaking={candidateSpeaking}
      interviewerSpeaking={interviewerSpeaking}
      muted={muted}
      mutePending={mutePending}
      playbackBlocked={playbackBlocked}
      transcript={transcript}
      events={events}
      audioRef={audioRef}
      onToggleMute={toggleMute}
      onEnd={endInterview}
      onRetry={() => void connect(config)}
      onBack={returnToSetup}
      onEnableAudio={() => {
        audioRef.current?.play().then(
          () => setPlaybackBlocked(false),
          () => setPlaybackBlocked(true),
        );
      }}
    />
  );
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function waitForIceGathering(peer: RTCPeerConnection, timeoutMs: number) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      reject(new Error("Timed out while gathering connection candidates."));
    }, timeoutMs);

    function onStateChange() {
      if (peer.iceGatheringState !== "complete") return;
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }

    peer.addEventListener("icegatheringstatechange", onStateChange);
    onStateChange();
  });
}

async function startMonitor(
  stream: MediaStream,
  setSpeaking: (value: boolean) => void,
  threshold: number,
) {
  const AudioContextClass = window.AudioContext;
  const context = new AudioContextClass();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.76;
  source.connect(analyser);

  const samples = new Uint8Array(analyser.frequencyBinCount);
  let frame = 0;
  let lastValue = false;
  let lastActiveAt = 0;
  let stopped = false;

  const read = () => {
    if (stopped) return;
    analyser.getByteFrequencyData(samples);
    let total = 0;
    for (const sample of samples) total += sample;
    const level = total / samples.length / 255;
    const now = performance.now();
    if (level > threshold) lastActiveAt = now;
    const active = now - lastActiveAt < 180;
    if (active !== lastValue) {
      lastValue = active;
      setSpeaking(active);
    }
    frame = requestAnimationFrame(read);
  };
  read();

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    source.disconnect();
    analyser.disconnect();
    void context.close();
    setSpeaking(false);
  };
}
