import type { ExecutionHandle, ExecutionProvider, Observation } from "../../lib/interview-service/provider";

/** Deterministic test double only; deliberately has no production registration. */
export class FakeExecutionProvider implements ExecutionProvider {
  capabilities = { trustedTranscript: true, trustedUsage: true, remoteStop: true, replayAfterDisconnect: true };
  private stopped = new Set<string>();
  private observations: Observation[];

  constructor(observations: Observation[]) {
    this.observations = structuredClone(observations);
  }

  async *observe(handle: ExecutionHandle): AsyncIterable<Observation> {
    if (this.stopped.has(handle.providerReference)) return;
    for (const event of this.observations) yield structuredClone(event);
  }

  async requestStop(handle: ExecutionHandle): Promise<void> {
    this.stopped.add(handle.providerReference);
  }
}
