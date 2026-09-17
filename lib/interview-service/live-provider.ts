import type { Observation } from "./provider.ts";
import type { InterviewRequest } from "./validation.ts";

export type TranscriptTurn = {
  id: string;
  speaker: "candidate" | "interviewer";
  text: string;
  start_ms: number;
  end_ms: number;
};
export interface LiveConnection {
  ready: Promise<void>;
  next(signal: AbortSignal): Promise<Observation | null>;
  stop(): void;
  close(): void;
}
/** Private provider boundary. SDP is the only provider transport data returned to the candidate. */
export interface LiveProvider {
  create(
    request: InterviewRequest,
    offer: string
  ): Promise<{ reference: string; answer: string }>;
  attach(reference: string): LiveConnection;
  hangup(reference: string): Promise<void>;
}
export interface Assessment {
  summary: string;
  competencies: {
    id: string;
    score: number | null;
    rationale: string;
    evidence_ids: string[];
  }[];
}
export interface LiveAssessor {
  assess(
    request: InterviewRequest,
    transcript: TranscriptTurn[]
  ): Promise<Assessment>;
}
export interface LiveOptions {
  accountIds: string[];
  provider: LiveProvider;
  assessor: LiveAssessor;
}
/** Stable, versioned turns, derived exclusively from ordered server observations. */
export function normalizeTranscript(events: Observation[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const event of events) {
    if (event.kind !== "transcript.fragment" || !event.text.trim()) continue;
    const last = turns.at(-1);
    if (
      last &&
      last.speaker === event.speaker &&
      event.startMs >= last.start_ms &&
      event.startMs <= last.end_ms + 1500 &&
      last.text.length + event.text.length < 30000
    ) {
      last.text += event.text;
      last.end_ms = Math.max(last.end_ms, event.endMs);
    } else
      turns.push({
        id: `turn_${turns.length + 1}`,
        speaker: event.speaker,
        text: event.text,
        start_ms: event.startMs,
        end_ms: event.endMs,
      });
  }
  return turns;
}
