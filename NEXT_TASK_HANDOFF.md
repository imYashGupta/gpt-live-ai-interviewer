# Next task handoff: Recooty AI interview integration

Updated 2026-09-19. Read `AI_INTERVIEW_WORK_STATE.md` first for the latest resume checkpoint, then this file and the applicable AGENTS.md files and the latest sections (14–17) of AI_INTERVIEW_INTEGRATION_PLAN.md. Earlier progress entries in that plan are historical; several gates described as pending there have since been tested.

## Durable deletion slice — completed locally

Recooty commit: `e06dd0e2f`. Service implementation and these checkpoints are grouped under `feat(interview-service): add durable interview deletion`; resolve its final hash from git log. Both branches remain `codex/ai-interview-integration`.

- Implemented service DELETE acceptance, authenticated deletion-status polling, immediate token/content revocation, retryable cleanup, active-session stopping and explicit unknown-provider blockers. Deleted interviews cannot be recreated by stale commands; late evidence, assessments and deliveries are fenced.
- Recooty erases its encrypted request/report/link and inbox copies, keeps minimal numeric audit, retries a stable remote deletion command, and detaches the application after service confirmation. Signed deletion events resolve by service identity; authenticated polling recovers missed callbacks. Tenant-authorized deletion still works with the pilot disabled.
- Existing recruiter application deletion and job-driven application cleanup use the same transaction and lock against new AI interview creation. Unresolved ATS creation is a deliberate 409 prerequisite: reconcile the remote mapping first. Team hard deletion remains restricted by tenant/accounting mappings.
- Automatic retention is disabled. No period is selected. Local completion is not evidence that provider persistence, backups, sent mail, browser downloads or unrelated legacy MVP archives were purged. Unknown provider creation remains pending. See plan section 18 for the full inventory and limits.
- Service tests: 33 database tests using disposable Herd schemas, 59 unit/contract/transport tests, lint and TypeScript passed. ATS: 44 focused tests / 315 assertions plus the existing nested application/human-interview deletion test / 9 assertions (45 tests / 324 assertions total). No frontend changes/build.
- Applied service migration 003 and ATS migration `2026_09_19_170401_add_deletion_state_to_ai_interviews.php` only to local Herd databases. Existing pilot/customer interviews were not deleted. All destructive tests used disposable synthetic fixtures and mocked providers.
- Restored Next HTTPS after the earlier processes exited outside this task. Latest observed PIDs: 22633/22634, exec session 73305. Capabilities returned 200, unknown deletion status 404, and there were no active/provisional live attempts. Service worker, dedicated ATS worker and scheduler are stopped; start only when needed after reinspection.
- API entry points: `DELETE /v1/interviews/{id}` with `Idempotency-Key`; `GET /v1/interviews/{id}/deletion`; existing authorized ATS action route with `action=delete` and a UUID `request_key`. This slice does not add a new recruiter delete button. An ATS request cannot revoke remote access during a service outage until the service receives the durable command; report that state as pending.

## Recommended next task

1. Decide lifecycle policy and prepare backup/restore acceptance that preserves tombstones. Unknown provider creation/usage needs evidence-based reconciliation; no silent completion or automatic reservation release. Design deletion of unresolved ATS creates and team/account shutdown separately.
2. Production webhook acceptance still needs an approved public HTTPS receiver, deployed outage testing, ownership verification and signing-key rotation. Preserve exact-host allowlisting and public IPv4 HTTPS on port 443. Paid billing stays disabled.
3. Use existing Herd databases, synthetic disposable fixtures and mocks. Reinspect matching processes and pending/active work before starting dedicated workers. Do not replay the existing unmapped manual settlement against an arbitrary application.
4. Continue checkpointing milestones and group related local commits. No push, deployment, paid sessions, invitations or production configuration changes were made in this slice.

The candidate presentation slice remains complete. Candidate live captions are unavailable; do not restore browser-authoritative provider controls.

## Candidate presentation slice — completed locally

- `/join` now uses the MVP's warm background, brand, coral orb on a dark green stage, participant card, responsive room layout and controls. Consent remains explicit before microphone access. The ready screen describes live processing and recruiter assessment; completion distinguishes successful completion from other terminal outcomes.
- Added an explicit **Enable sound** action for blocked autoplay and correct disconnected status. End disables capture immediately, keeps WebRTC until service confirmation (or the existing bounded timeout), and permits retry with the microphone off. Countdown/progress use the service deadline and cannot finalize the interview. Reload still cannot restart a live attempt.
- No backend/API/provider changes, dependencies, migrations, ATS edits, paid provider sessions, invitations, billing, worker starts, push or deployment. Production webhook gate and host policy remain unchanged.
- Lint, non-incremental TypeScript, whitespace checks and 57 service tests passed (2 database suites skipped). The existing database suite was not rerun for presentation-only changes.
- `tests/browser/candidate-presentation.js` passed with intercepted candidate HTTP and mocked media/WebRTC: consent, microphone denial, playback recovery, mute, connection loss/recovery, stop retry/ordering, service completion, reload, revocation and terminal states. Desktop/mobile screenshots were inspected at 1440/390px, without horizontal overflow. Expected simulated HTTP 503/401 failures produced network console messages; no page exceptions.
- Re-run with the Playwright CLI skill in an isolated session: open the existing HTTPS `/join` page, then `playwright-cli --session candidate-presentation run-code --filename tests/browser/candidate-presentation.js`. The script starts from a fresh document, removes its HTTP routes afterward and leaves the page blank. Close that isolated browser afterward to discard its media init scripts. It must never be used for a real interview.
- Ignored visual evidence is in `output/playwright/candidate-*.png`. The orb is decorative; it does not claim to detect speech. Live captions would require a separately designed, service-owned read-only projection rather than trusting browser provider events.
- Reconciled service `bbbf48c` / ATS `7d9031833` at start. Only the related service presentation/checkpoint files are committed for this slice; preserve service `tsconfig.tsbuildinfo` and ATS `composer.lock`.

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
- Phase 3: CloudTech-only unbilled live pilot and local report/usage outage recovery are verified. Durable usage inbox isolates stale/unmapped records; terminal UI polling and pending/failed/provisional states are tested. Public webhook and deployed acceptance gates remain open.
- Phase 4: paid subscription allowances, real debit/grant policy and retail settlement enforcement not started/completed.
- Later: full AI fixed/slot scheduling, production hardening, standalone client UI and a second real provider.

Do not label all of Phase 2/3 production-ready based on the local pilot.

## Recent fixes and evidence

Service commits:

- `9d5652e` fix(interview-service): control interview pacing and complete intentional stops
- `e848b12` fix(interview-service): restore live pilot startup and opening speech
- `2a974f3` feat(interview-service): connect live rooms to durable execution

Recooty commits:

- `2d38657de`: independent report recovery, durable usage inbox, terminal delivery UI/polling and Phase 3 regressions.

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
- `components/candidate-live-room.tsx`, `app/join/join.tsx`: integrated candidate room and admission
- `components/candidate-presentation.tsx`, `candidate-interview.module.css`: candidate presentation reusing MVP room styles
- `tests/browser/candidate-presentation.js`: mocked candidate presentation/lifecycle browser regression
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
- Invitations disabled. Customer billing zero. The local HTTP Recooty webhook endpoint is active only for the non-production allowlisted environment; there is no public production endpoint.
- Service ignored `.env` / `.env.local` contain the OpenAI key, existing Herd database configuration, origin and encryption key. Recooty's ignored `.env` contains its integration configuration. Do not print or copy secrets into committed files.
- `.data/recooty-test-credential.json` is the existing private service credential file; use only for authorized service API actions. Do not fabricate login cookies or bypass recruiter authentication.
- API calls from Node can use `--use-system-ca` to trust the installed Herd certificate; keep TLS verification enabled.

At handoff, the Next HTTPS dev process was restarted in tool session `82895` after Recooty displayed its service-unavailable fallback. Recooty's authenticated capabilities request then succeeded with schema version `1.0` and adaptive mode. Session handles can change; verify the endpoint instead of assuming the process survived. Older service-worker and ATS-worker PIDs in historical notes were not revalidated or restarted during this slice.

When background processing is needed, start only the dedicated workers after checking for existing matching processes:

```sh
npm run service:worker
php artisan queue:work ai --queue='{ai-interview-pilot}' --sleep=1 --timeout=160 --tries=1 --no-interaction
```

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
- Two-minute automatic completion: service interview `int_849548f0ef5aef8266d7cf43afc807a5`; ATS interview `b124bb1b-19dd-4c6e-9492-f9be6357983a`. Its link was rotated during browser-session recovery; completed links cannot restart. Verified through normal **Sync status** and recruiter UI: ready revision 1, 13 transcript turns, one settlement with 117 measured seconds and zero billable seconds.
- Manual completion: service interview `int_dc441a06a9a6241bf497bf5ee8fdcc8c`. Created through the authenticated service API using the internal test configuration; it has no corresponding ATS interview row. Do not expect it to appear in the ATS UI.
- Older pilot attempts intentionally remain interrupted/insufficient-evidence as recorded before the fix.
- Generated speech files and browser diagnostic scripts were under `/tmp`, not source assets. Do not depend on them existing or include invitation tokens in the handoff.

## Remaining boundaries

- Seamless reconnect/provider replay is not implemented. Reload cannot restore a live media attempt; recovery stops uncertain sessions rather than duplicating them.
- Provider sessions may cost money even though customer charge is zero. Use mocks for routine tests and bounded internal live checks only when needed.
- Public webhook verification, ownership challenge and producer secret rotation are unfinished. Local private-address delivery is allowed only outside production and only for exact allowlisted hosts; production remains public HTTPS-only.
- Reviewed plans, rescheduling/listing gaps, private artifacts, retention policy/restore acceptance, environment separation, rate limits, provider cost calibration and paid allowance enforcement remain in the broader plan.
- Do not promise full production readiness, automatically alter hiring outcomes, silently relabel historical interrupted attempts, or expose candidate data in logs/handoff documents.

## Phase 3 recovery implementation and local operations

- Recooty independently retries report and usage delivery. Listings distinguish remote status from local availability; UI continues refreshing incomplete delivery after execution ends and refreshes the open report.
- `ai_interview_usage_inbox` stores encrypted records before cursor advancement. Valid mapped records enter the existing deduplicated ledger independently. Unknown/missing mappings remain `mapping_pending`; failed identity/quantity/charge checks remain `usage_validation_failed`. They stay unprocessed and retry on later workspace syncs; `interviews:reconcile` shows the pending count. Resolve ownership against authoritative service state; never attach unmatched usage arbitrarily or edit settled quantities to force import.
- Local-only migration applied: `2026_09_18_171835_create_ai_interview_usage_inbox_table.php`. Dedicated pilot worker restarted; service/Next workers unchanged. On another environment, migrate before starting workers with this code. No public contract or pinned schema change was necessary.
- Local inbox: nine records received, eight imported, one service-only manual test remains pending (`set_db1d1d5300740ba7029bdc11a41d5746`, interview `int_dc441a06a9a6241bf497bf5ee8fdcc8c`). It has no ATS interview and is not a missing report for the pilot application.
- Browser-only response simulations verified terminal polling across pending, failed/provisional and recovered states, including an already-open report; real responses were restored afterward.
- Verification: 34 focused ATS tests / 234 assertions, 55 service unit/contract/transport tests and 25 Herd PostgreSQL integration tests. Service lint/typecheck, ATS Pint/build passed. ATS global typecheck has its unchanged 1,112 baseline diagnostics, none in changed files; Sentry source-map upload still reports its pre-existing project error.
- No new interview/provider session, invitation email, charge, push or deployment was performed in this slice. Cursor-based interview discovery remains deferred because existing mappings and durable command retries cover these recovery cases.
