# AI interview integration: resume checkpoint

Updated: 2026-09-19. Read NEXT_TASK_HANDOFF.md and plan sections 16–17 for details. This records observed state, not authorization to expand scope.

## Objective and completed work

- Environment-scoped webhook delivery is implemented and locally accepted. Exact host allowlisting applies everywhere; development/test permits explicitly allowlisted HTTP/private IPv4 destinations, while production requires public IPv4 HTTPS on port 443.
- The canonical webhook schema and Recooty's pinned snapshot now permit HTTP URLs; runtime policy enforces the environment-specific restrictions. Local HTTPS certificate verification remains enabled.
- A signed replay of the existing pilot `result.ready` event reached Recooty over `http://recooty.test`, entered its durable inbox and was processed after authenticated report/usage recovery. A bounded unused-port outage persisted a retry; restoring the endpoint completed the same job on attempt two and left one processed Recooty inbox row.
- Phase 3 local report-delivery/recovery slice implemented and verified; public HTTPS webhook/deployed acceptance remains deferred. User permits local HTTP Recooty, with HTTPS planned for production; destination protections remain unchanged.
- Recooty independently recovers report and usage, persists encrypted usage pages before cursor advancement, imports valid records separately, retains unresolved ownership/validation records, and displays/polls report/usage delivery states after execution ends.
- Existing authenticated CloudTech pilot recovered on its correct application: ready report revision 1, 13 transcript turns, 3 competencies; one settlement with 117 measured seconds and zero billable seconds. No new provider session, email, charge, push or deployment.
- Cursor-based interview listing is not needed for these gaps. Existing mappings and idempotent commands suffice; broader discovery remains deferred.

## Branches and working trees

- Service: `/Users/yashgupta/WORK/gpt-live-ai-interviewer`, `codex/ai-interview-integration`.
- ATS: `/Users/yashgupta/Laravel/recooty`, same branch.
- ATS recovery commit: `2d38657de`. Service grouped commit: `test(interview-service): verify phase 3 delivery recovery` (contains this checkpoint; resolve its hash with git log). Prior checkpoint commit was `22cb024`.
- The environment-scoped webhook implementation, contract snapshots, acceptance evidence and this checkpoint are grouped in the latest commit of each branch.
- Preserve unrelated service `tsconfig.tsbuildinfo` (untracked) and ATS `composer.lock` (modified).

## Verification

- Service: 59 tests ran with 57 passing and 2 database suites skipped by the unit command; 25 integration tests passed separately on existing Herd PostgreSQL. Lint/typecheck passed. Outbox lost-acknowledgment/restart replay preserves event and settlement identity.
- Local network: signed delivery completed in one attempt; outage replay recorded `job_failed`, then completed on attempt two after restoration. Recooty retained one processed inbox row for the event.
- Recooty pinned contract: 13 tests / 64 assertions passed.
- ATS: 34 focused tests / 234 assertions; Pint, Prettier and Vite build passed. Global TypeScript has unchanged 1,112 baseline errors, none in changed files. Existing Sentry source-map project error remains unrelated.
- Browser: real report/transcript/usage verified. Browser-only mocked responses verified terminal polling and open-report refresh across pending, failed/provisional and recovered states. All temporary routes removed; real data restored.

## Runtime and unresolved records

- Only local ATS migration `2026_09_18_171835_create_ai_interview_usage_inbox_table.php` applied. No service migration needed.
- The local endpoint is active at `http://recooty.test/api/interview-service/webhook`; its secret exists only in Recooty's ignored local environment. Recooty later showed its service-unavailable fallback because the bounded Next HTTPS process had been stopped. The documented HTTPS dev server was restarted in tool session `82895`; Recooty then authenticated to `/v1/capabilities` and received schema version `1.0` with adaptive mode. Recheck the process before relying on that session. No persistent service or queue worker was started by this task.
- No active service attempts at runtime inspection. ATS reconciliation ran with zero pending commands; all integration mappings are team 1.
- Usage inbox: nine received, eight imported, one `mapping_pending` service-only test (`set_db1d1d5300740ba7029bdc11a41d5746`, `int_dc441a06a9a6241bf497bf5ee8fdcc8c`). It has no ATS row and must not be assigned arbitrarily. It no longer blocks other records or cursor advancement.

## Pending / next safe action

- No pending local operation or unverified implementation remains for this slice.
- Next safe action: use an approved public HTTPS receiver for production-mode signed delivery/deployed outage acceptance and then ownership verification/key rotation. If none exists, continue the deferred candidate presentation or lifecycle/privacy work. Do not enable paid billing.
