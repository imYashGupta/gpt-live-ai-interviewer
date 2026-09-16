import type { ConnectServerEvent } from "openai/resources/live/sideband/sideband";
import type { Observation, ProviderCapabilities } from "../provider";

/** Source/SDK capabilities, not a claim that live recovery has been verified. */
export const openaiLiveCapabilities: ProviderCapabilities = {
  trustedTranscript: true,
  trustedUsage: true,
  remoteStop: true,
  replayAfterDisconnect: false,
};

function milliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid provider usage");
  const value = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(value)) throw new Error("Provider usage exceeds supported precision");
  return value;
}

/** Call only with events received on an authenticated server-side connection. */
export function normalizeOpenAILiveEvent(event: ConnectServerEvent): Observation | null {
  switch (event.type) {
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      return {
        id: event.event_id, kind: "transcript.fragment",
        speaker: event.type === "session.input_transcript.delta" ? "candidate" : "interviewer",
        text: event.delta, startMs: event.start_ms, endMs: event.end_ms,
      };
    case "session.usage.updated":
      return { id: event.event_id, kind: "usage.snapshot", cumulativeAudioMs: milliseconds(event.usage.seconds) };
    case "session.closed":
      return {
        id: event.event_id, kind: "execution.closed", cumulativeAudioMs: milliseconds(event.usage.seconds),
        outcome: event.reason === "connection_lost" ? "interrupted" : event.reason === "content" ? "failed" : "completed",
      };
    default:
      return null;
  }
}

/** Closing the observer socket alone does not stop the underlying interview. */
export function openaiLiveStopCommand(commandId: string) {
  return { type: "session.close", event_id: commandId } as const;
}
