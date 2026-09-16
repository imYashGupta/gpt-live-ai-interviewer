import type { ExecutionHandle, ExecutionProvider, Observation } from "../provider.ts";

/** Server-owned synthetic data for contract/durability verification. No model or microphone calls. */
export class SandboxExecutionProvider implements ExecutionProvider {
  capabilities = { trustedTranscript: true, trustedUsage: true, remoteStop: true, replayAfterDisconnect: true };
  async *observe(handle: ExecutionHandle): AsyncIterable<Observation> {
    if (!handle.providerReference) throw new Error("Missing sandbox execution reference");
    yield { id: "sandbox_question", kind: "transcript.fragment", speaker: "interviewer", text: "Synthetic test: describe how you verify a change.", startMs: 0, endMs: 3000 };
    yield { id: "sandbox_answer", kind: "transcript.fragment", speaker: "candidate", text: "Synthetic test response: I run focused tests and inspect the result.", startMs: 3000, endMs: 10000 };
    yield { id: "sandbox_usage", kind: "usage.snapshot", cumulativeAudioMs: 10000 };
    yield { id: "sandbox_closed", kind: "execution.closed", cumulativeAudioMs: 10000, outcome: "completed" };
  }
  async requestStop(handle: ExecutionHandle) {
    if (!handle.providerReference) throw new Error("Missing sandbox execution reference");
  }
}
