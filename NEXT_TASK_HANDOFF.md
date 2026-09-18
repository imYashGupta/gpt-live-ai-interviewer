# Next task handoff: Recooty AI interview integration

Updated 2026-09-18. Read `AI_INTERVIEW_WORK_STATE.md` first for the latest resume checkpoint, then this file and the applicable AGENTS.md files and the latest sections (14–15) of AI_INTERVIEW_INTEGRATION_PLAN.md. Earlier progress entries in that plan are historical; several gates described as pending there have since been tested.

## Recommended next task

Finish the **Phase 3 result-delivery and recovery acceptance slice** before starting paid billing. The live interview path is working locally, including spoken opening, quick/overlapping answers, timed closing, intentional End, background assessment, and usage settlement. The next priority is proving the recruiter reliably receives the correct report and usage after an outage, with clear pending/failed states.

1. Inspect current Recooty reconciliation/inbox/command processing and service outbox behavior before changing anything. Much of this is already implemented and tested.
2. Verify a completed live pilot's transcript, assessment and usage on its correct Recooty application using authenticated APIs/UI. Use existing internal test results when possible; do not repeatedly run paid interviews to prove the same behavior.
3. Exercise delayed/missed callbacks, repeated delivery, out-of-order events and polling recovery. Cover report-pending/failed and usage-provisional states. Add focused tests or fix concrete gaps uncovered; preserve resource-version and settlement deduplication.
4. Determine whether the missing cursor-based interview listing is needed for the identified recovery gaps. If implementing it, keep it tenant-scoped, provider-neutral and capability/contract compatible; update canonical schemas and the Recooty pinned snapshot together. Do not assume every proposed endpoint in the plan already exists.
5. Local/private webhook delivery is deliberately blocked. Complete all local/stubbed checks first. Actual signed webhook delivery needs an authorized, controlled public HTTPS staging receiver. Ask for missing staging details only when needed; do not disable SSRF/TLS protections or claim local mocks prove this gate.
6. Update the phase plan with exact delivered behavior and remaining gates. Commit related changes, one meaningful commit per repository where practical. Do not enable customer charging, send candidate emails, deploy, or push as part of this slice.

The user preferred the original MVP UI, but explicitly accepted deferring that work. A subsequent candidate-experience slice should reuse its presentation while retaining the new service-owned session/evidence/metering flow. Do not copy the MVP's browser-authoritative provider controls into the integrated room.

## Product and architecture decisions

- Recooty ATS is the first client of an independent multi-tenant interview service. Other clients must be possible later.
- External ATS/service API and data are provider-neutral. OpenAI/GPT-Live, LiveKit, model names, vendor session IDs and raw events stay behind private adapters. Replacing the provider must not change Recooty business logic.
- Tenant model: client account -> workspace -> interview -> attempt. Recooty is an account; each ATS team maps to its own workspace.
- Server API credentials authenticate clients. Candidates use invitation exchange and scoped HttpOnly sessions; no candidate account or OAuth is currently required.
- Service owns authoritative transcripts, assessments, measured usage and session termination. The browser transports media and requests actions; it cannot submit authoritative transcripts, costs or final outcomes.
- Recooty owns ATS workflow and future customer subscriptions/retail billing using its existing Soulbscription integration. Service credits/consumption are separate. Current implementation uses zero-charge shadow settlement; paid wallets/allowances remain unfinished.
- Existing fixed-time and candidate-selected-slot human interviews must remain unaffected. AI interviews currently use an availability window; full AI fixed/slot scheduling is later work and may require the careers repository/recooty/core release coordination.

## Repositories, branches and user rules

Both existing checkouts are on `codex/ai-interview-integration`:

- Service: `/Users/yashgupta/WORK/gpt-live-ai-interviewer`
- Recooty: `/Users/yashgupta/Laravel/recooty` (already a Git worktree)

User commit guideline: Conventional Commits, related files grouped, no emoji, no co-author, no excessive small commits. User has authorized commits at completed work boundaries. No push requested.

Preserve unrelated working-tree files:

- Service: untracked `tsconfig.tsbuildinfo`
- Recooty: modified `composer.lock`

Use **the existing Herd PostgreSQL server**, not Docker or a newly isolated PostgreSQL instance. Integration tests use disposable schemas on that server and clean them up. Recooty has an existing guarded Herd test database.

Read AGENTS.md in each repository. The service uses Next 16.3 with breaking changes: read relevant installed guides in `node_modules/next/dist/docs/` before editing Next code. Read current official OpenAI docs/installed SDK before provider changes. Do not change dependencies or vendor code without a concrete need and appropriate authorization. No sub-agent delegation unless explicitly requested.

## Current phase status

- Phase 1: provider-neutral contract, fixtures, normalizers and consumer/provider tests implemented.
- Phase 2: PostgreSQL tenancy, durable jobs, reservations, scoped admission, trusted live capture, assessment, outbox and conservative recovery implemented. The broader phase is not fully complete: planning, lifecycle/privacy, reconciliation and operational prerequisites remain.
- Phase 3: Recooty integration and a CloudTech-only unbilled local live pilot work. Report/usage polling has been verified. Public webhook and broader failure/deployed acceptance gates remain open.
- Phase 4: paid subscription allowances, real debit/grant policy and retail settlement enforcement not started/completed.
- Later: full AI fixed/slot scheduling, production hardening, standalone client UI and a second real provider.

Do not label all of Phase 2/3 production-ready based on the local pilot.

## Recent fixes and evidence

Service commits:

- `9d5652e` fix(interview-service): control interview pacing and complete intentional stops
- `e848b12` fix(interview-service): restore live pilot startup and opening speech
- `2a974f3` feat(interview-service): connect live rooms to durable execution

Recooty commits:

- `63e6e3d3d` docs(interview-service): record timing and completion verification
- `4a221c2a5` fix(interview-service): support link actions on local HTTP origins
- `1e8c856fc` docs(interview-service): record live pilot implementation and acceptance gates

Resolved problems:

1. Next HMR/hydration failed on the Herd domain. `next.config.ts` now allows `interview-bot.test` as a development origin.
2. Recooty on HTTP lacks `crypto.randomUUID()` and sometimes Clipboard API. Secure UUID byte fallback and selectable candidate-link input are implemented. Create, replace and manual copy were verified after normal user login.
3. New live integration initially connected silently. Server sideband now sends greeting instructions after session.started, waits for the matching acknowledgment, then sends a begin cue. Startup waits are bounded; browser provider commands remain disabled.
4. AI estimated duration from question count and said goodbye too early. Prompt now treats rapid answers, barge-in and pauses as normal. Private `LiveConnection.updateTimeRemaining(seconds)` receives the persisted service clock. OpenAI gets quiet context per 30-second bucket, one final-20-second wrap-up instruction and an acknowledged closing-speech cue. Hard closure remains server controlled; no transcript phrase is a stop command.
5. End disconnected WebRTC before remote closure, incorrectly yielding interrupted. It now disables microphone input immediately, pauses playback, requests stop and waits up to 15 seconds for terminal status before releasing WebRTC. Genuine capture/transport failures still remain interrupted/provisional. Historical results were not relabeled.
6. UI shows wrap-up/ending and removes stale countdown/in-progress messages when closed. This is still the basic integrated UI, not the richer MVP.

Latest verification:

- 55 service unit/contract/transport tests passed.
- 24 integration tests passed using temporary schemas on existing Herd PostgreSQL.
- Lint and TypeScript passed. Transport tests were rerun after the final closing-cue and duplicate-stop guards.
- A real two-minute interview with five generated quick answers, including overlapping a question, remained active and completed automatically at about 122 seconds. Final usage settled and assessment became ready.
- A separate one-minute configuration spoke its closing, then candidate End completed at about 47 seconds with `candidate_end`, completed status, settled usage and a ready assessment.
- These tests used generated speech and did not capture the physical microphone. They do not guarantee every future model utterance follows the prompt or prove all network-failure cases.
- Earlier ATS checks: request-key unit tests, 13 focused integration tests / 90 assertions, Pint and Vite build passed. The build's existing Sentry source-map upload emitted an unrelated project configuration error. Repository-wide ATS TypeScript had an unchanged baseline of 1,112 existing errors; avoid claiming it is globally clean.

## Useful implementation locations

Service:

- `contracts/interview-service/v1/`: canonical public contract/fixtures
- `lib/interview-service/service.ts`, `http.ts`, `candidate.ts`: account and candidate APIs
- `lib/interview-service/live-provider.ts`: private live/assessment boundary
- `lib/interview-service/live-worker.ts`: leased execution, time/stop supervision, trusted evidence and assessment
- `lib/interview-service/providers/openai-live.ts`: provider configuration, sideband greeting/clock/closing
- `lib/interview-service/providers/openai-live-observation.ts`: provider event normalization
- `lib/interview-service/worker.ts`, `delivery.ts`, `job-leases.ts`: durable work/delivery
- `components/candidate-live-room.tsx`, `app/join/join.tsx`: integrated candidate room
- `components/interview-app.tsx`, `interview-room.tsx`, `transcript-panel.tsx`: original MVP reference only
- `scripts/interview-service.mjs`: migrate/provision/worker/attempts/jobs/replay operator commands
- `INTERVIEW_SERVICE_SETUP.md`: setup, operational boundaries and acceptance checks

Recooty:

- `resources/js/Components/Partials/Interview/AiInterviewPanel.tsx`
- `resources/js/Utils/requestKey.ts`
- `tests/Feature/InterviewService/`, `tests/Unit/BrowserRequestKeyTest.php`
- `tests/Fixtures/InterviewService/v1/`: pinned public contract
- Search `app/` for InterviewService classes, commands and inbox handlers; do not infer filenames.

## Local runtime (verify before reusing)

- Service origin: `https://interview-bot.test:3000`
- ATS origin: `http://recooty.test`, served by Herd
- Enabled team: **CloudTech, team 1**. Other teams remain disabled.
- Live allowlist is configured for the existing Recooty service account.
- Invitations disabled. Customer billing zero. No public webhook endpoint is activated for this local receiver.
- Service ignored `.env` / `.env.local` contain the OpenAI key, existing Herd database configuration, origin and encryption key. Recooty's ignored `.env` contains its integration configuration. Do not print or copy secrets into committed files.
- `.data/recooty-test-credential.json` is the existing private service credential file; use only for authorized service API actions. Do not fabricate login cookies or bypass recruiter authentication.
- API calls from Node can use `--use-system-ca` to trust the installed Herd certificate; keep TLS verification enabled.

At handoff the following processes were running (PIDs/session handles can change):

- Next HTTPS dev process, originally PID 4218
- Service worker PID 90484, started with `npm run service:worker`
- Dedicated ATS worker PID 7019:
  `php artisan queue:work ai --queue='{ai-interview-pilot}' --sleep=1 --timeout=160 --tries=1 --no-interaction`

Before restarting the service worker, inspect active attempts; graceful shutdown drains work. Do not kill unrelated processes. Full ATS scheduler/Horizon was not started by this task.

If Next needs restarting, use existing Herd TLS files:

```sh
npm run dev -- --hostname 127.0.0.1 --experimental-https \
  --experimental-https-key '/Users/yashgupta/Library/Application Support/Herd/config/valet/Certificates/interview-bot.test.key' \
  --experimental-https-cert '/Users/yashgupta/Library/Application Support/Herd/config/valet/Certificates/interview-bot.test.crt'
```

Useful checks:

```sh
npm run lint
npx tsc --noEmit --incremental false
npm test
npm run test:database
node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/interview-service.mjs attempts
```

`npm test` skips the database suites unless database env is supplied; `npm run test:database` explicitly requires the configured Herd database. No migration is required for the latest timing/end fixes.

## Browser and test records

Playwright CLI skill/wrapper was used with session `pilot-debug` from `/tmp`. Session tabs may have been closed/recreated by the user; inspect before acting. User had normally signed in to Recooty earlier. If expired, ask for normal sign-in; never forge auth. Do not close unrelated tabs or the entire browser.

- Internal pilot application: `http://recooty.test/jobs/social-media-intern-cl103/application/28b5733aea38be3d`, application 117, synthetic candidate under CloudTech's Social Media Intern role.
- Two-minute automatic completion: service interview `int_849548f0ef5aef8266d7cf43afc807a5`; ATS interview `b124bb1b-19dd-4c6e-9492-f9be6357983a`. Its link was rotated during browser-session recovery; completed links cannot restart. It may need normal **Sync status** in Recooty to fetch the latest result.
- Manual completion: service interview `int_dc441a06a9a6241bf497bf5ee8fdcc8c`. Created through the authenticated service API using the internal test configuration; it has no corresponding ATS interview row. Do not expect it to appear in the ATS UI.
- Older pilot attempts intentionally remain interrupted/insufficient-evidence as recorded before the fix.
- Generated speech files and browser diagnostic scripts were under `/tmp`, not source assets. Do not depend on them existing or include invitation tokens in the handoff.

## Remaining boundaries

- Seamless reconnect/provider replay is not implemented. Reload cannot restore a live media attempt; recovery stops uncertain sessions rather than duplicating them.
- Provider sessions may cost money even though customer charge is zero. Use mocks for routine tests and bounded internal live checks only when needed.
- Public webhook verification, ownership challenge and producer secret rotation are unfinished; local private-address delivery must remain blocked.
- Reviewed plans, rescheduling/listing gaps, private artifacts, retention/deletion, environment separation, rate limits, provider cost calibration and paid allowance enforcement remain in the broader plan.
- Do not promise full production readiness, automatically alter hiring outcomes, silently relabel historical interrupted attempts, or expose candidate data in logs/handoff documents.
