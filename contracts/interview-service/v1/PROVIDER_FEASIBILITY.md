# GPT-Live capture and metering feasibility

Inspected 2026-09-16 against installed OpenAI JS SDK 7.15.0 and official documentation.
Status: source-level feasibility established; paid live validation and durable worker
implementation are still required before enabling billing.

## Evidence and implementation boundary

The [official sideband reference](https://developers.openai.com/api/reference/resources/live/sideband-websocket)
and installed `openai/src/resources/live/sideband/{ws,sideband}.ts` expose an
authenticated server sideband connection with transcript, usage, and terminal events.
The adapter in `lib/interview-service/providers/openai-live-observation.ts` normalizes
these event types to our internal Observation type and compiles against the SDK types.

The [session creation reference](https://developers.openai.com/api/reference/typescript/resources/live/methods/create)
and installed `live.ts` expose controls restricting frontend client events. Production
sessions must disable candidate-side instruction/configuration mutation and text/history
injection. Otherwise server capture alone would not establish trustworthy answer evidence.

- Input/output transcript events are fragments, not complete turns. Preserve arrival
  sequence and timing; group into stable turns in a separate, versioned normalization step.
- Usage snapshots are cumulative audio seconds. The reducer keeps the maximum interim
  value, deduplicates event IDs, and rejects inconsistent finalization.
- `session.close` requests execution termination. Closing the sideband socket alone
  does not terminate the primary WebRTC session.
- `session.closed` carries final usage; socket closure without it cannot finalize billing.

## Recovery gaps that remain unproven

Automatic reconnect in the installed SDK is not evidence of missed-event replay.
No transcript replay cursor or post-session usage lookup was established in the inspected
sideband interface. Keep `replayAfterDisconnect: false`; mark capture incomplete on gaps.
A reconnect may recover later cumulative usage without recovering missing transcript text.
Do not turn partial evidence into a full assessment or assume zero missing usage.

Provider audio seconds also require comparison with our intended billable connected-time
policy, including silence, mute, network gaps, and failed attempts. Store provider usage
as measurement evidence; do not label it customer-billable time without that calibration.

## Next implementation and live acceptance checks

Use a long-running Node worker for sideband ownership, duration watchdogs, and capture;
a short-lived Next.js request is not a worker lifecycle. Store raw received events and
normalized checkpoints transactionally in PostgreSQL, with unique provider-session/event
keys and explicit worker leases. The reducer's in-memory event map is a testable checkpoint
model, not the final high-volume storage design.

The database choice is PostgreSQL. Use a PostgreSQL-backed durable job mechanism and an
outbox in the first deployment; the precise queue package and hosting provider remain
Phase 2 implementation choices. Record those before provisioning infrastructure.

Before paid launch, run a bounded real-provider test covering sideband attachment before
candidate speech, candidate control restrictions, silence/mute accounting, forced stop,
primary disconnect, observer disconnect/reconnect, worker restart, final usage, and consent
settings. Prove how to stop or quarantine sessions when the observer cannot recover.
If trusted capture cannot be guaranteed for direct WebRTC, use a server-mediated transport
or keep the rollout unbilled. No real-provider sessions were started for this contract work.
