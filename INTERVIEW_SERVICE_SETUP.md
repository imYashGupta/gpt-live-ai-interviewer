# Interview service sandbox

Phase 2 foundations run alongside the MVP. The new service is **test-only**: its execution adapter emits synthetic transcript events, assessment returns `insufficient_evidence`, and settlements have zero billable seconds and credits. This is not yet the candidate-facing live interview product.

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

The local service origin is `https://localhost:3000`. Keep `INTERVIEW_SERVICE_ORIGIN` equal to the browser's HTTPS origin; candidate POST requests verify it. Secure candidate cookies require HTTPS. Next's HTTPS development command may set up a local certificate; an existing Herd HTTPS reverse proxy is also suitable when configured to forward to Next. Update the origin if using a different host or port.

On another installation, copy the service settings from `.env.example`, set `INTERVIEW_DATABASE_URL` to a **dedicated database**, generate a stable 32-byte hex `INTERVIEW_SERVICE_ENCRYPTION_KEY`, then enable `INTERVIEW_SERVICE_ENABLED=true`. Share that key between the API and worker; keep it in a secret manager in deployment. Changing it without re-encrypting rows invalidates encrypted replay responses and webhook secrets.

## Available API

All `/v1` requests use `Authorization: Bearer <service credential>`. All mutations also require `Idempotency-Key`. Discover supported configuration IDs using capabilities; currently these are `sandbox_default` and `sandbox_v1`, English audio, adaptive mode, 60–3600 seconds.

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

Schemas and example requests live under `contracts/interview-service/v1`. The schema is provider-neutral; unsupported configuration is rejected. Interview creation does not send an email. Recooty's future integration will own invitations.

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
- `replay JOB_ID`: requeue a dead job, preserving the existing attempt/event identity.
- `activate-webhook ENDPOINT_ID`: activate a registered destination after ownership has been verified by the operator. Set `INTERVIEW_WEBHOOK_HOSTS` to the exact allowed hostname first.
- `import-legacy SQLITE_PATH`: repeatable, read-only import into the internal/demo archive. Changed previously imported records require review.
- `worker --once`: run at most one job plus the expiry sweep.

Webhook delivery is HTTPS-only, IPv4-only, pins a validated public DNS address, rejects credentials/private addresses/redirects, and bounds delivery time. Local Herd/private webhook receivers are deliberately not reachable by this transport. Automated tests inject an in-process receiver; no actual messages are sent. Operator activation does not implement automated ownership challenges or signing-key rotation yet. Only events created after activation are queued for that endpoint.

Bodies are serialized into the outbox once. Retries preserve event IDs and use fresh signing timestamps. Consumers must deduplicate. Jobs use 30-second leases and transaction fencing. Failed jobs retry with backoff and become dead after six failed executions; inspect and replay or cancel stranded sandbox attempts to release reservations. A repeatedly killed worker may reclaim an unfinished job; the effect stays idempotent. This short sandbox worker does not yet implement the lease renewal needed for long live sessions.

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

## Remaining Phase 2 work

Connect the actual GPT-Live adapter and hosted room behind these interfaces, capture trusted incremental evidence and final usage, renew worker leases during long sessions, and generate real evidence-based assessments. Finish reviewed plans, reconciliation listing, rescheduling, private artifacts, deletion/retention, webhook ownership/secret rotation, and production rate limits. Validate provider costs and billing semantics before paid usage. The provider name/session ID must remain private to the service.

Recooty's UI, scheduling models, inbound inbox, and Soulbscription consumption remain later phases. The fake flow verifies the service boundary and persistence; it does not complete the full Phase 2 exit gate or establish production readiness.
