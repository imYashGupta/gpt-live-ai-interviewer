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
npm run build && npm run start -- --hostname 127.0.0.1 --port 3000
```

For an HMR development server instead, substitute `npm run dev -- --hostname 127.0.0.1 --port 3000`. Neither command needs `--experimental-https`.

In another terminal:

```sh
npm run service:worker
```

The activated Herd pilot uses `https://ai-interviewer.test`, served by a Herd nginx proxy site created with `herd proxy ai-interviewer http://127.0.0.1:3000 --secure`. Nginx terminates TLS with a trusted Herd certificate and forwards to Next over plain HTTP on loopback, so Next itself runs without `--experimental-https` and the origin carries no port. Herd's proxy stub already sets `X-Forwarded-Proto`, passes websocket upgrades, disables response buffering and allows 1800s upstream reads, which live sessions, streaming responses and HMR all need. `next.config.ts` allows `ai-interviewer.test` as a development origin for HMR; `allowedDevOrigins` matches the `Origin` hostname only, without scheme or port. Keep `INTERVIEW_SERVICE_ORIGIN` equal to the browser's HTTPS origin; candidate POST requests verify it. Secure candidate cookies require HTTPS. Update the origin, and the ATS `INTERVIEW_SERVICE_BASE_URL`, together if the host changes. The unrelated Laravel app at `/Users/yashgupta/Laravel/interview-bot/` keeps `interview-bot.test`; do not reuse that hostname here.

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
| `GET /v1/interviews/{id}/artifacts` | Available; `video_recording` with a short-lived playback link once the recording is `ready` or `incomplete` |
| `GET /v1/interviews/{id}/integrity` | Available (contract 0.2.0); tab, focus and camera signals plus recording gaps for review |
| Plan creation/read/approval, interview listing/update | Contract declared; implementation pending |

Schemas and example requests live under `contracts/interview-service/v1`. The schema is provider-neutral; unsupported configuration is rejected. Interview creation does not send an email. Recooty's integration owns invitations; delivery remains disabled by default.

Open the returned `/join#...` link and click **Continue** to exchange it for a single-interview session. GET requests never redeem a token. The fragment is removed from browser history and is never submitted as a URL query. Click **Run synthetic test** to create one durable attempt. Refresh status after the worker runs. Closing the tab does not stop the queued test. A lost browser session after redemption requires a new link while the interview is unstarted; automatic cross-device session recovery is not implemented.

Workspaces are unlimited by default (`allowance_seconds` is NULL) and allow 25 concurrent attempts; migration 004 converted the former 36,000-second / five-attempt defaults. An operator can still set a cap on a workspace. Admission reserves the configured duration. The concurrency cap is runaway-cost protection, independent of monetary credit grants or Recooty subscriptions, which the client enforces itself. The sandbox produces ten synthetic measured seconds when completed; its billable quantity is always zero. Cancelled started attempts persist measured progress with zero billing. Unstarted cancellations/expirations create no usage record.

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

Webhook delivery always requires an exact hostname in `INTERVIEW_WEBHOOK_HOSTS`, pins the resolved IPv4 address, rejects credentials/fragments/redirects, and bounds delivery time. In production (`NODE_ENV=production`) it additionally requires HTTPS on port 443, rejects IP-literal hosts, and rejects every private, loopback, link-local, reserved or multicast answer. In development/test, explicitly allowlisted HTTP, localhost, `.test`, IP-literal and private IPv4 destinations are accepted so local applications can exercise the real signed transport. Local HTTPS still verifies certificates. Operator activation does not implement automated ownership challenges or signing-key rotation yet. Only events created after activation are queued for that endpoint.

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
INTERVIEW_WORKER_CONCURRENCY=4
```

Set `OPENAI_API_KEY` server-side. `INTERVIEW_LIVE_ENABLED` defaults to false; when true, every client account gets real interviews (there is no per-account allowlist). To stop one client, disable its account. Turning the flag off refuses new live starts while existing sessions are still stopped and recovered.

In Recooty, the panel is visible only to teams whose plan grants `BETA_FEATURES` (the former team allowlist was removed). For a live-pilot account set `INTERVIEW_SERVICE_SANDBOX=false` so its screen and optional invitation accurately describe an actual interview, rather than synthetic data. Keep `INTERVIEW_SERVICE_ALLOW_INVITATIONS=false` until an internal delivery test is authorized. This flag change does not enable customer billing. Recooty discovers `pilot_default` / `pilot_v1` through the unchanged capabilities API; no vendor-specific ATS code is needed. Refresh after the one-minute capability cache expires.

Use a trusted HTTPS service origin. Open a newly generated link, continue, read the audio/transcript disclosure, and explicitly consent. The candidate page obtains microphone permission and submits only an SDP offer plus consent version. It receives an SDP answer only after the worker connects its authenticated sideband observer. Provider session IDs, API credentials, controls, transcript submission, usage submission and report generation are not exposed to this page. Stop and mute controls remain available; consent and its timestamp are stored on the attempt.

`gpt-live-1` execution and `gpt-5.6-luna` assessment are private adapter choices. The startup data-channel policy disables all candidate provider commands, including instruction/history injection. Only normalized server-side transcript fragments and cumulative usage are persisted; reflected raw audio is discarded. The app does not store an audio recording. Fragments become deterministic evidence turns; numeric rubric scores must cite actual candidate turns and remain subject to recruiter review.

Keep the candidate tab open. ICE recovery within the same peer connection may recover audio, but reloading or switching devices does not create a new provider session or reconstruct the old media connection. A different SDP for an existing attempt is rejected. On observer loss or worker restart, the service requests remote termination and provides an incomplete, unscored report. This intentionally does not claim transcript replay support.

The worker enforces the admission deadline, candidate stop and employer cancellation. Remote cancellation retains the quota reservation until final usage is confirmed. If final usage is missing, status stays provisional and the reservation stays held for operator reconciliation. Use `attempts` to find these cases; do not replace unknown usage with zero or configured duration. Unknown creation responses are quarantined rather than retried, because duplicate provider creation cannot be ruled out. Missing session identifiers or final usage require provider/operator investigation; automatic recovery of those facts is not implemented.

Known final provider usage is mirrored with `pilot_zero_v1`, zero billable quantity and zero credits. Provider audio seconds have not been calibrated to the intended retail policy. A live test still incurs provider costs even though customers are not charged.

To stop new live admission, disable the flag in API and worker configuration and restart both processes. Keep the key/adapter configured while stopping or recovering existing sessions. Do not kill all capture workers as a rollback mechanism; use graceful draining and explicit cancellation. A separate supervised worker process must restart after failure; the web process is not the capture worker.

## Verification and remaining gates

The live implementation adds a real SDK/local WebSocket transport test and PostgreSQL lifecycle tests with injected providers. These cover browser control restrictions, consent, stable SDP admission, duplicate evidence, settlement uniqueness, candidate/end deadlines, cancellation, capture loss, lost creation responses, stale leases, recovery, failed remote stops, bounded assessment retries and configuration rollback. No paid OpenAI session is started by the test suite. Test-only schemas are created on the existing Herd server and removed afterward.

Before inviting real candidates, run a bounded real-provider acceptance test covering audio startup, sideband readiness, control restrictions, silent/muted time, candidate/remote stop, browser closure, worker interruption and final usage. Local development may verify real signed delivery to the allowlisted HTTP Recooty receiver. Production acceptance still requires a controlled public HTTPS receiver plus authenticated polling. This validates behavior that mocked sessions cannot prove.

Still pending: reviewed plans, reconciliation listing, rescheduling, private artifacts, deletion/retention, webhook ownership challenges/producer secret rotation, production/test environment separation, production rate limits, provider cost calibration and paid allowance enforcement. The Phase 2/3 production exit gates remain open until those prerequisites and the real-provider pilot are verified. The MVP's original SQLite/passcode workflow is unchanged.

## Local CloudTech activation — 2026-09-18

Recooty's additive AI interview migration is applied to the existing Herd `local_recooty` database. Its ignored local configuration enables only CloudTech (team 1), uses the existing private service credential and trusted HTTPS origin above, and keeps invitation emails disabled. Its live screen has `INTERVIEW_SERVICE_SANDBOX=false`; customer usage still settles at zero charge.

The local ATS worker uses the dedicated `{ai-interview-pilot}` queue on connection `ai`, so it does not consume unrelated jobs:

```sh
php artisan queue:work ai --queue='{ai-interview-pilot}' --sleep=1 --timeout=160 --tries=1 --no-interaction
```

The interview API and separate service worker must also be running. These development processes are not an installed supervisor. For local delivery, register `http://recooty.test/api/interview-service/webhook`, set `INTERVIEW_WEBHOOK_HOSTS=recooty.test` for the service worker, configure the returned signing secret in Recooty, activate the endpoint, and keep `NODE_ENV` outside production. **Sync status** and `interviews:reconcile` remain the recovery path. The full application scheduler was not started.

An internal pilot application exists under CloudTech's Social Media Intern role with a two-minute interview. Its link was created through the actual queued ATS integration. Browser testing confirmed that Continue opens the audio consent screen without microphone activation. The initial local failures were a blocked Next development origin (preventing reliable hydration) and `crypto.randomUUID()` being unavailable on Recooty's HTTP development origin; the ATS now generates UUIDs using Web Crypto random bytes when necessary and displays a selectable link when clipboard access is unavailable. Signed-in browser verification covered create, replace and manual copying on Recooty's HTTP origin. Refresh existing browser tabs after installing these fixes and reopen the complete invitation link if its fragment was lost during an earlier reload.

The integrated provider must explicitly initiate the opening. Its server sideband now follows the [GPT-Live greeting sequence](https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks): append English greeting instructions after `session.started`, match the acknowledgment, then send one begin commentary command. Each startup/acknowledgment wait is bounded to ten seconds. The WebRTC answer is released independently so microphone media can start; candidate-side provider commands remain disabled. Restart the separate service worker after adapter changes.

A real-provider check using synthetic silence verified the AI welcome/first question, nonzero incoming audio, browser playback, trusted transcript capture and final usage (69 seconds, zero customer charge). Recooty recovered the insufficient-evidence report and settled usage through **Sync status**. No physical microphone was captured and no candidate answer or substantive assessment was tested. The run ended as interrupted because browser media closed before remote stop completed; that stop ordering is corrected below. Controlled public webhook delivery remains an acceptance gate.


## Timing and completion correction

The worker supplies the persisted deadline to a provider-neutral `updateTimeRemaining` method. The OpenAI adapter sends quiet clock context at 30-second intervals and one wrap-up instruction in the final 20 seconds, followed by a closing-speech cue once acknowledged. Quick answers and overlapping speech must not cause an early farewell. The worker remains responsible for actual closure at the deadline; no transcript phrase is treated as a stop command. These controls follow the [provider context-update guidance](https://developers.openai.com/api/docs/guides/live-delegation#send-the-right-kind-of-update).

Candidate End disables microphone input immediately but keeps WebRTC alive while the server requests and confirms provider closure. The browser waits at most 15 seconds, then releases media and shows either terminal status or a retry message. This preserves authoritative final usage and completion instead of deliberately causing a transport interruption. The wrap-up/countdown and terminal messages reflect the service lifecycle. Real network/capture failures remain interrupted; historical results are unchanged.

Verified with two bounded generated-speech runs: quick/overlapping answers continued to the two-minute deadline and completed automatically; a separate run spoke the closing and completed normally through the candidate End button at about 47 seconds. Both settled usage and produced ready assessments, with zero customer charges. Broader human conversation, failure recovery and public webhook acceptance still need coverage. Restart the service worker and refresh the candidate page before creating new attempts with these fixes.


## Recooty report/usage recovery acceptance (2026-09-18)

The local report-delivery slice reuses the completed CloudTech pilot. Authenticated polling recovered its ready assessment and transcript plus one zero-charge settlement (117 measured seconds). A real signed HTTP replay reached `recooty.test`, entered its durable inbox and was processed. A bounded unused-port outage left the same delivery pending, then completed on attempt two after the endpoint was restored; Recooty retained one processed inbox row. Repeated/delayed callbacks, API outages and lost delivery acknowledgment across restart are also covered by focused tests. Public HTTPS delivery remains a production gate.

Recooty requires its additive `2026_09_18_171835_create_ai_interview_usage_inbox_table.php` migration before running the updated worker. It durably receives encrypted usage pages before advancing its cursor, then imports records separately. `interviews:reconcile` reports unresolved inbox records; inspect their `last_error` and reconcile ownership before taking action. `mapping_pending` can resolve after a missing interview/attempt mapping syncs; `usage_validation_failed` requires checking identity, quantities and charge policy. Unmapped service-only records must never be assigned to unrelated applications. Existing settled usage remains deduplicated.

Local reconciliation imported all eight mapped records and retained the one service-only manual test as pending review. The candidate page and provider path were not changed by this recovery work. See section 16 of `AI_INTERVIEW_INTEGRATION_PLAN.md` for exact acceptance evidence and remaining gates.

## Billable seconds

Every client receives billable seconds; whether to charge its own customers is the client's decision. Settlements carry `billable_quantity` equal to the measured seconds for `completed` and employer-`cancelled` attempts, capped at the configured duration, with `rate_card_version` `seconds_v1`. `interrupted` and `failed` attempts, the synthetic provider and deleted interviews settle zero billable seconds. The service adds no balance or allowance of its own; the client enforces it. Recooty holds and consumes its `AI_INTERVIEW_SECONDS` plan feature behind `INTERVIEW_SERVICE_BILLING=true`, which requires `INTERVIEW_SERVICE_SANDBOX=false` because Recooty rejects nonzero charges in sandbox mode.

## Provisioning a client

Create one client per consuming environment, for example `recooty`, `recooty_staging` and `recooty_dev`, so their usage is reported separately. Options use `--name=value`, with or without `--` after the script name:

```sh
npm run service:provision --client=recooty_staging --webhook=https://staging.recooty.app/api/interview-service/webhook
```

This creates the client account, an account-level credential and the client's single workspace, and prints them once as the Recooty settings below. With `--webhook=URL` it also registers that client's webhook, already active, and prints its signing secret. The credential is stored only as a hash and cannot be shown again; issue a new one with `credential` if it is lost. To write them to a private file instead (never overwriting an existing one), add `--output=.data/recooty_staging-credential.json`. Configure that environment of the client with those three values (Recooty: `INTERVIEW_SERVICE_ACCOUNT_ID`, `INTERVIEW_SERVICE_CREDENTIAL`, `INTERVIEW_SERVICE_WORKSPACE_ID`, `INTERVIEW_SERVICE_WEBHOOK_SECRET`) and delete any credential file afterwards. Names are lowercase letters, digits and underscores and must be unique. The service does not track the client's own teams or customers.

```sh
npm run service:clients            # interviews and measured/billable minutes per client, this month (UTC)
npm run service:clients -- 2026-09 # a given month
npm run service:rename -- acct_... recooty_dev
```

## Webhooks for a client environment

Pass `--webhook=URL` when provisioning, or add one to an existing client (by name or account ID):

```sh
npm run service:webhook --client=recooty_dev --webhook=https://dev.recooty.app/api/interview-service/webhook
```

It prints `INTERVIEW_SERVICE_WEBHOOK_SECRET` for that Recooty environment's `.env` (clear its config cache afterwards). The endpoint is active at once and receives every event; only events created from then on are delivered, and polling covers earlier ones. Rerunning for the same URL issues a new secret: keep the old one in `INTERVIEW_SERVICE_PREVIOUS_WEBHOOK_SECRET` until the new one is in place. Production delivery still requires public HTTPS on port 443. `INTERVIEW_WEBHOOK_HOSTS` is optional; when set, only those hostnames receive webhooks. Endpoints registered through the API stay pending until `npm run service:activate-webhook -- we_...`.

Other client commands: `npm run service:credential -- ACCOUNT_ID OUTPUT_FILE` issues a new credential, `npm run service:revoke -- key_...` revokes one.

Troubleshooting: `npm run service:attempts` lists live attempts that are active or ended without final usage (`connection_state` `queued` = never started, `creating` = provider rejected the session, `created`/`observing` = dropped mid-session). `npm run service:jobs` lists unfinished and dead jobs with their last error; `npm run service:replay -- job_...` requeues a dead job after its cause is fixed. The worker log names the reason each live attempt was interrupted.

## Video recording storage

Recording is off unless `INTERVIEW_RECORDING_ENABLED=true`. The candidate's browser uploads chunks straight to a private
S3 bucket through presigned POST links that pin the object key, the type (`video/webm` or `video/mp4`) and a maximum size
(`INTERVIEW_RECORDING_MAX_CHUNK_BYTES`, default 8 MiB). Recruiters play back through presigned GET links
(`INTERVIEW_RECORDING_PLAYBACK_TTL_SECONDS`, default 900). Objects are stored as
`<prefix><account>/<interview>/<attempt>/chunks/00000.webm`, so one attempt is deleted by its prefix.

Create one bucket per environment (dev and production separately):

1. Create the bucket in the app's region with Block Public Access fully on. Default encryption (SSE-S3) is on for new buckets; keep it.
2. CORS, so the candidate page can upload and the report can play back. Replace the origin with `INTERVIEW_SERVICE_ORIGIN`:

   ```json
   [{ "AllowedOrigins": ["https://recooty-interview.on-forge.com"], "AllowedMethods": ["POST", "GET", "HEAD"],
      "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
   ```

3. An IAM user for the app with only this policy (replace the bucket name and prefix), then put its access key in the
   app's `.env` as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Never commit or paste the key elsewhere.

   ```json
   { "Version": "2012-10-17", "Statement": [
     { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
       "Resource": "arn:aws:s3:::BUCKET/interviews/*" },
     { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::BUCKET",
       "Condition": { "StringLike": { "s3:prefix": "interviews/*" } } } ] }
   ```

4. Set `INTERVIEW_RECORDING_ENABLED=true`, `INTERVIEW_RECORDING_S3_BUCKET` and `INTERVIEW_RECORDING_S3_REGION`, then run:

   ```bash
   npm run service:recording-check
   ```

   It uploads a small test object exactly as the browser will, confirms S3 refuses an oversized upload, plays it back
   through a presigned link, joins two chunks the way the worker does, confirms anonymous access is blocked, and
   deletes everything it created. It does not need the database.
   The browser upload also needs CORS, which this server-side check cannot exercise.

After an interview, the worker queues a `recording` job once the upload window has closed (5 minutes after the
attempt ends, checked every 30 seconds). The job joins the confirmed chunks into `recording.webm` (or `.mp4`) with a
multipart upload and deletes the chunk objects. The recording becomes `ready`, `incomplete` (some chunks missing; the
file still plays) or `failed` (the first chunk, which holds the video header, never arrived; chunks are kept). Chunk
rows stay in the database as evidence of gaps. The worker must run with the same `INTERVIEW_RECORDING_*` settings.

Recruiters read recordings through `GET /v1/interviews/{id}/artifacts` (playback links last
`INTERVIEW_RECORDING_PLAYBACK_TTL_SECONDS`) and review signals through `GET /v1/interviews/{id}/integrity`. Deleting
an interview removes its signals and chunk records at once; the deletion job then purges its S3 objects, purges again
after any upload link issued before deletion has expired, and reports `recording_purge_pending`,
`recording_storage_unavailable` or `recording_delete_failed` as the blocker until done. No automatic retention period
is applied to recordings yet.
