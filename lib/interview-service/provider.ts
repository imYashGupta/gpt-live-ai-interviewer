/** Internal boundary: these types are never serialized to the ATS or candidate. */
export interface ProviderCapabilities {
  trustedTranscript: boolean;
  trustedUsage: boolean;
  remoteStop: boolean;
  replayAfterDisconnect: boolean;
}

export type Observation =
  | { id: string; kind: "transcript.fragment"; speaker: "candidate" | "interviewer"; text: string; startMs: number; endMs: number }
  | { id: string; kind: "usage.snapshot"; cumulativeAudioMs: number }
  | { id: string; kind: "execution.closed"; cumulativeAudioMs: number; outcome: "completed" | "interrupted" | "failed" };

export interface ExecutionHandle {
  /** Persist privately so a worker can reattach; never use as our interview ID. */
  providerReference: string;
}

export interface ExecutionProvider {
  capabilities: ProviderCapabilities;
  observe(handle: ExecutionHandle): AsyncIterable<Observation>;
  requestStop(handle: ExecutionHandle): Promise<void>;
}

export interface QuestionPlanner {
  plan(context: { role: string; durationSeconds: number }): Promise<{
    questions: Array<{ id: string; text: string; competencyId: string }>;
  }>;
}

export interface AssessmentProvider {
  assess(input: {
    rubricVersionId: string;
    transcript: Array<{ id: string; speaker: "candidate" | "interviewer"; text: string }>;
  }): Promise<{
    summary: string;
    competencies: Array<{ id: string; score: number | null; evidenceIds: string[] }>;
  }>;
}

export interface ObservationState {
  /** Worker checkpoint; persist atomically with its normalized observations. */
  events: Record<string, Observation>;
  fragments: Array<Extract<Observation, { kind: "transcript.fragment" }>>;
  cumulativeAudioMs: number;
  usageStatus: "pending" | "provisional" | "final";
  outcome: "completed" | "interrupted" | "failed" | null;
  captureIncomplete: boolean;
}

export function initialObservationState(): ObservationState {
  return { events: {}, fragments: [], cumulativeAudioMs: 0, usageStatus: "pending", outcome: null, captureIncomplete: false };
}

/** A transport disconnect does not prove provider finalization or transcript completeness. */
export function markCaptureGap(state: ObservationState): ObservationState {
  return { ...state, captureIncomplete: true };
}

export function applyObservation(state: ObservationState, event: Observation): ObservationState {
  if (!event.id || event.id.length > 255) throw new Error("Invalid observation ID");
  const previous = Object.hasOwn(state.events, event.id) ? state.events[event.id] : undefined;
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("Conflicting observation replay");
    return state;
  }
  if (state.usageStatus === "final") throw new Error("Observation after finalization requires reconciliation");
  if (event.kind === "transcript.fragment") {
    if (![event.startMs, event.endMs].every((n) => Number.isSafeInteger(n) && n >= 0)
      || event.endMs < event.startMs || typeof event.text !== "string" || event.text.length > 30_000
      || !["candidate", "interviewer"].includes(event.speaker)) throw new Error("Invalid transcript fragment");
    return {
      ...state, events: { ...state.events, [event.id]: structuredClone(event) },
      fragments: [...state.fragments, structuredClone(event)],
    };
  }
  if (!["usage.snapshot", "execution.closed"].includes(event.kind)
    || !Number.isSafeInteger(event.cumulativeAudioMs) || event.cumulativeAudioMs < 0) {
    throw new Error("Invalid cumulative usage");
  }
  if (event.kind === "execution.closed" && event.cumulativeAudioMs < state.cumulativeAudioMs) {
    throw new Error("Final usage regressed; reconciliation required");
  }
  if (event.kind === "execution.closed" && !["completed", "interrupted", "failed"].includes(event.outcome)) {
    throw new Error("Invalid execution outcome");
  }
  return {
    ...state, events: { ...state.events, [event.id]: structuredClone(event) },
    cumulativeAudioMs: Math.max(state.cumulativeAudioMs, event.cumulativeAudioMs),
    usageStatus: event.kind === "execution.closed" ? "final" : "provisional",
    outcome: event.kind === "execution.closed" ? event.outcome : state.outcome,
  };
}
