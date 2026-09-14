export type Difficulty = "junior" | "mid" | "senior";
export type InterviewMode = "ai-led" | "planned";

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
  mode: InterviewMode;
  candidateName: string;
  role: string;
  jobDescription: string;
  durationMinutes: number;
  difficulty: Difficulty;
  voice: LiveVoice;
  followUpsEnabled: boolean;
  candidateNotes: string;
}

export interface InterviewQuestion {
  id: string;
  topic: string;
  question: string;
  intent: string;
  followUps: string[];
}

export interface PlanGenerationUsage {
  model: "gpt-5.6-luna";
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface InterviewPlan {
  summary: string;
  questions: InterviewQuestion[];
  generation: PlanGenerationUsage;
}

export interface InterviewPlanResponse {
  plan: InterviewPlan;
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
