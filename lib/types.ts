export type Difficulty = "junior" | "mid" | "senior";

export const LIVE_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "beacon",
  "bossa",
  "cedar",
  "cinder",
  "coral",
  "delta",
  "echo",
  "gleam",
  "marin",
  "meridian",
  "quartz",
  "ripple",
  "sage",
  "shimmer",
  "stone",
  "tempo",
  "verse",
  "vesper",
  "willow",
] as const;

export type LiveVoice = (typeof LIVE_VOICES)[number];

export const GPT_LIVE_PRICE_USD_PER_MINUTE = 0.05;

export interface InterviewConfig {
  candidateName: string;
  role: string;
  jobDescription: string;
  durationMinutes: number;
  difficulty: Difficulty;
  voice: LiveVoice;
  candidateNotes: string;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "ending"
  | "ended"
  | "error";

export interface TranscriptEntry {
  id: string;
  speaker: "candidate" | "interviewer";
  text: string;
  startMs: number;
  endMs: number;
}

export interface DebugEvent {
  id: string;
  receivedAt: string;
  direction: "in" | "out";
  event: Record<string, unknown>;
}

export interface LiveSessionResponse {
  session: { id: string };
  transport: { type: "webrtc"; sdp: string };
}
