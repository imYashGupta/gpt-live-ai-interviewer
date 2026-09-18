# Interview service setup

The independent service runs alongside the MVP. By default it uses a synthetic execution adapter and zero-charge settlements. An explicitly enabled, account-allowlisted live pilot now connects microphone audio to a server-supervised provider session, captures transcript evidence and produces background assessments. The live implementation has passed local mocked-provider tests; a paid end-to-end provider acceptance run is still required before candidate rollout. Customer billing remains disabled in both modes.

## Local database and credentials

Use the existing Herd PostgreSQL instance. The development database is `gpt_live_interviewer`, separate from Recooty. On this machine, Herd allows the `root` role over its `/tmp` Unix socket; TCP requires a password. The ignored `.env.local` contains the socket connection URL, a generated encryption key, and the sandbox configuration. No new database server was installed.

Recooty has been provisioned as a test service account. Its 90-day credential is in `.data/recooty-test-credential.json` (mode 0600, ignored by Git). Keep this server-side. Do not paste it into a browser bundle, URL, screenshot, or commit. Each employer will have a workspace under this account; a future independent client gets its own account.

The existing SQLite record was copied into the internal/demo archive. SQLite remains the MVP's source; archived records do not become customer interviews or usage.

## Run

Use Node 22.18+ (native TypeScript stripping) and the installed npm dependencies:

```sh
npm run service:migrate
npm run dev -- --experimental-https
```

In another terminal:

```sh
npm run service:worker
```

The activated Herd pilot uses `https://interview-bot.test:3000`, with the existing `interview-bot.test` certificate and key passed to Next's HTTPS flags. `next.config.ts` explicitly allows that development hostname for HMR. The generic HTTPS command above uses `https://localhost:3000`; set the origin to match whichever address you run. Keep `INTERVIEW_SERVICE_ORIGIN` equal to the browser's HTTPS origin; candidate POST requests verify it. Secure candidate cookies require HTTPS. Next's HTTPS development command may set up a local certificate; an existing Herd HTTPS reverse proxy is also suitable when configured to forward to Next. Update the origin if using a different host or port.

On another installation, copy the service settings from `.env.example`, set `INTERVIEW_DATABASE_URL` to a **dedicated database**, generate a stable 32-byte hex `INTERVIEW_SERVICE_ENCRYPTION_KEY`, then enable `INTERVIEW_SERVICE_ENABLED=true`. Share that key between the API and worker; keep it in a secret manager in deployment. Changing it without re-encrypting rows invalidates encrypted replay responses and webhook secrets.

## Available API

All `/v1` requests use `Authorization: Bearer <service credential>`. All mutations also require `Idempotency-Key`. Discover supported configuration IDs using capabilities; synthetic accounts use `sandbox_default` / `sandbox_v1`; allowlisted live-pilot accounts use `pilot_default` / `pilot_v1`. Both support English audio, adaptive mode, 60–3600 seconds. These are service profile/rubric IDs, not provider names. Routing is pinned on each interview at creation, so enabling live mode never converts an existing synthetic invitation.

| Endpoint | State |
| --- | --- |
| `GET /v1/capabilities` | Available |
| `POST /v1/workspaces` | Available; stable external reference per account |
| `POST /v1/interviews` | Available; persists configuration and authorization budget |
| `GET /v1/interviews/{id}` | Available; tenant-scoped status polling |
| `POST /v1/interviews/{id}/access-links` | Available; replacing a link revokes prior access |
| `POST /v1/interviews/{id}/cancel` | Available; expected resource version required |
| `GET /v1/interviews/{id}/result` | Available after worker assessment |
| `GET /v1/usage` | Available; workspace filter and append-only cursor |
| `GET /v1/balance` | Available; zero-price sandbox returns zero credit balances |
| `POST /v1/webhook-endpoints` | Available; pending operator verification |
| Plan creation/read/approval, interview listing/update/deletion, artifacts | Contract declared; implementation pending |

Schemas and example requests live under `contracts/interview-service/v1`. The schema is provider-neutral; unsupported configuration is rejected. Interview creation does not send an email. Recooty's integration owns invitations; delivery remains disabled by default.

Open the returned `/join#...` link and click **Continue** to exchange it for a single-interview session. GET requests never redeem a token. The fragment is removed from browser history and is never submitted as a URL query. Click **Run synthetic test** to create one durable attempt. Refresh status after the worker runs. Closing the tab does not stop the queued test. A lost browser session after redemption requires a new link while the interview is unstarted; automatic cross-device session recovery is not implemented.

The default workspace sandbox allowance is 36,000 measured seconds and five concurrent attempts. Admission reserves the configured duration. These are operational test quotas, independent of monetary credit grants or Recooty subscriptions. The sandbox produces ten synthetic measured seconds when completed; its billable quantity is always zero. Cancelled started attempts persist measured progress with zero billing. Unstarted cancellations/expirations create no usage record.

## Operator commands

The following prefix loads the local environment:

```sh
node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/interview-service.mjs COMMAND
```

Commands:

- `provision NAME OUTPUT_FILE`: create another test account and save its first credential privately.
- `credential ACCOUNT_ID OUTPUT_FILE [WORKSPACE_ID]`: issue a replacement/account or workspace-scoped credential; use a new output filename. Update the client, then revoke the old credential.
- `revoke CREDENTIAL_ID`: stop new requests using that credential.
- `jobs`: inspect pending/running/dead jobs without exposing payloads or secrets.
- `attempts`: inspect active live attempts and provisional-usage cases, including uncertain session creation/capture, without printing SDP, transcripts, or credentials.
- `replay JOB_ID`: requeue a dead job, preserving the existing attempt/event identity.
- `activate-webhook ENDPOINT_ID`: activate a registered destination after ownership has been verified by the operator. Set `INTERVIEW_WEBHOOK_HOSTS` to the exact allowed hostname first.
- `import-legacy SQLITE_PATH`: repeatable, read-only import into the internal/demo archive. Changed previously imported records require review.
- `worker --once`: run at most one job plus the expiry sweep.

Webhook delivery is HTTPS-only, IPv4-only, pins a validated public DNS address, rejects credentials/private addresses/redirects, and bounds delivery time. Local Herd/private webhook receivers are deliberately not reachable by this transport. Automated tests inject an in-process receiver; no actual messages are sent. Operator activation does not implement automated ownership challenges or signing-key rotation yet. Only events created after activation are queued for that endpoint.

Bodies are serialized into the outbox once. Retries preserve event IDs and use fresh signing timestamps. Consumers must deduplicate. Jobs use 30-second leases and transaction fencing. Live capture renews ownership throughout the session. Workers use bounded concurrency (default four, configurable 2–20), reserving a slot for assessment/delivery rather than letting long sessions occupy every slot. Failed delivery/stop work becomes dead after six attempts; assessment becomes visibly failed after three attempts. Inspect and replay operational failures after correcting their cause. Graceful shutdown stops intake and drains active work; forced restarts stop recovered live sessions instead of claiming replay of missed transcript events.

## Verification

```sh
npm test
npm run test:database
npm run lint
npx tsc --noEmit --incremental false
npm run build
```

`test:database` requires an existing configured PostgreSQL server. It uses `INTERVIEW_TEST_DATABASE_URL` when provided, otherwise `INTERVIEW_DATABASE_URL`, creates a uniquely named temporary schema, and removes only that schema. It does not start an isolated server or reset the development/public schema. The normal `npm test` skips this database suite when no URL is supplied; the explicit database command fails if no URL is configured.

Covered: strict schemas, tenant and scope boundaries, key revocation, concurrent command/start deduplication, replay after reconnect/key rotation, atomic quotas, invitation/session revocation, origin enforcement, worker recovery and stale-lease fencing, terminal settlement uniqueness, expiry, legacy import, signed callbacks, retry/dead-letter replay, and error redaction.

## Enable an internal live pilot

The local migration `002_live_execution.sql` has been applied on Herd. Run `npm run service:migrate` in each other environment before starting the updated API/worker. Migration 001 is unchanged and checksummed; existing interviews remain synthetic.

Keep these settings identical in API and worker processes:

```dotenv
INTERVIEW_LIVE_ENABLED=true
INTERVIEW_LIVE_ACCOUNT_IDS=acct_internal_pilot
INTERVIEW_WORKER_CONCURRENCY=4
```

Set `OPENAI_API_KEY` server-side. Do not reuse the example account ID; allowlist the explicitly selected internal service account. The code still uses the existing test credential namespace and test account environment for this unbilled integration pilot; full production/test account separation remains a rollout prerequisite. `INTERVIEW_LIVE_ENABLED` defaults to false. The local Recooty service account is now enabled for the CloudTech internal pilot; other installations remain opt-in.

In Recooty, keep the explicit internal team allowlist. For a live-pilot account set `INTERVIEW_SERVICE_SANDBOX=false` so its screen and optional invitation accurately describe an actual interview, rather than synthetic data. Keep `INTERVIEW_SERVICE_ALLOW_INVITATIONS=false` until an internal delivery test is authorized. This flag change does not enable customer billing. Recooty discovers `pilot_default` / `pilot_v1` through the unchanged capabilities API; no vendor-specific ATS code is needed. Refresh after the one-minute capability cache expires.

Use a trusted HTTPS service origin. Open a newly generated link, continue, read the audio/transcript disclosure, and explicitly consent. The candidate page obtains microphone permission and submits only an SDP offer plus consent version. It receives an SDP answer only after the worker connects its authenticated sideband observer. Provider session IDs, API credentials, controls, transcript submission, usage submission and report generation are not exposed to this page. Stop and mute controls remain available; consent and its timestamp are stored on the attempt.

`gpt-live-1` execution and `gpt-5.6-luna` assessment are private adapter choices. The startup data-channel policy disables all candidate provider commands, including instruction/history injection. Only normalized server-side transcript fragments and cumulative usage are persisted; reflected raw audio is discarded. The app does not store an audio recording. Fragments become deterministic evidence turns; numeric rubric scores must cite actual candidate turns and remain subject to recruiter review.

Keep the candidate tab open. ICE recovery within the same peer connection may recover audio, but reloading or switching devices does not create a new provider session or reconstruct the old media connection. A different SDP for an existing attempt is rejected. On observer loss or worker restart, the service requests remote termination and provides an incomplete, unscored report. This intentionally does not claim transcript replay support.

The worker enforces the admission deadline, candidate stop and employer cancellation. Remote cancellation retains the quota reservation until final usage is confirmed. If final usage is missing, status stays provisional and the reservation stays held for operator reconciliation. Use `attempts` to find these cases; do not replace unknown usage with zero or configured duration. Unknown creation responses are quarantined rather than retried, because duplicate provider creation cannot be ruled out. Missing session identifiers or final usage require provider/operator investigation; automatic recovery of those facts is not implemented.

Known final provider usage is mirrored with `pilot_zero_v1`, zero billable quantity and zero credits. Provider audio seconds have not been calibrated to the intended retail policy. A live test still incurs provider costs even though customers are not charged.

To stop new live admission, disable the flag in API and worker configuration and restart both processes. Keep the key/adapter configured while stopping or recovering existing sessions. Do not kill all capture workers as a rollback mechanism; use graceful draining and explicit cancellation. A separate supervised worker process must restart after failure; the web process is not the capture worker.

## Verification and remaining gates

The live implementation adds a real SDK/local WebSocket transport test and PostgreSQL lifecycle tests with injected providers. These cover browser control restrictions, consent, stable SDP admission, duplicate evidence, settlement uniqueness, candidate/end deadlines, cancellation, capture loss, lost creation responses, stale leases, recovery, failed remote stops, bounded assessment retries and configuration rollback. No paid OpenAI session is started by the test suite. Test-only schemas are created on the existing Herd server and removed afterward.

Before inviting real candidates, run a bounded real-provider acceptance test covering audio startup, sideband readiness, control restrictions, silent/muted time, candidate/remote stop, browser closure, worker interruption and final usage. Verify result delivery through a controlled public HTTPS webhook receiver and authenticated polling in Recooty. This validates behavior that mocked sessions cannot prove.

Still pending: reviewed plans, reconciliation listing, rescheduling, private artifacts, deletion/retention, webhook ownership challenges/producer secret rotation, production/test environment separation, production rate limits, provider cost calibration and paid allowance enforcement. The Phase 2/3 production exit gates remain open until those prerequisites and the real-provider pilot are verified. The MVP's original SQLite/passcode workflow is unchanged.

## Local CloudTech activation — 2026-09-18

Recooty's additive AI interview migration is applied to the existing Herd `local_recooty` database. Its ignored local configuration enables only CloudTech (team 1), uses the existing private service credential and trusted HTTPS origin above, and keeps invitation emails disabled. Its live screen has `INTERVIEW_SERVICE_SANDBOX=false`; customer usage still settles at zero charge.

The local ATS worker uses the dedicated `{ai-interview-pilot}` queue on connection `ai`, so it does not consume unrelated jobs:

```sh
php artisan queue:work ai --queue='{ai-interview-pilot}' --sleep=1 --timeout=160 --tries=1 --no-interaction
```

The interview API and separate service worker must also be running. These development processes are not an installed supervisor. Local webhook delivery remains blocked by the public-destination policy; use **Sync status** in Recooty for the pilot, or run its existing `interviews:reconcile` command. The full application scheduler was not started.

An internal pilot application exists under CloudTech's Social Media Intern role with a two-minute interview. Its link was created through the actual queued ATS integration. Browser testing confirmed that Continue opens the audio consent screen without microphone activation. The initial local failures were a blocked Next development origin (preventing reliable hydration) and `crypto.randomUUID()` being unavailable on Recooty's HTTP development origin; the ATS now generates UUIDs using Web Crypto random bytes when necessary and displays a selectable link when clipboard access is unavailable. Signed-in browser verification covered create, replace and manual copying on Recooty's HTTP origin. Refresh existing browser tabs after installing these fixes and reopen the complete invitation link if its fragment was lost during an earlier reload.

The integrated provider must explicitly initiate the opening. Its server sideband now follows the [GPT-Live greeting sequence](https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks): append English greeting instructions after `session.started`, match the acknowledgment, then send one begin commentary command. Each startup/acknowledgment wait is bounded to ten seconds. The WebRTC answer is released independently so microphone media can start; candidate-side provider commands remain disabled. Restart the separate service worker after adapter changes.

A real-provider check using synthetic silence verified the AI welcome/first question, nonzero incoming audio, browser playback, trusted transcript capture and final usage (69 seconds, zero customer charge). Recooty recovered the insufficient-evidence report and settled usage through **Sync status**. No physical microphone was captured and no candidate answer or substantive assessment was tested. The run ended as interrupted because browser media closed before remote stop completed; graceful stop ordering remains a follow-up. A two-way spoken interview, substantive assessment and controlled public webhook delivery remain acceptance gates.
