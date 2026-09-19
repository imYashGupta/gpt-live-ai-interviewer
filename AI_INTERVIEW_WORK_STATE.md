# AI interview integration: resume checkpoint

Updated: 2026-09-19. Read NEXT_TASK_HANDOFF.md and plan section 18 for implementation details.

## Objective and completed work
- Durable deletion implemented across service and ATS: tenant authorization, tombstones, immediate service revocation, copy erasure, retryable cleanup, active-provider stop/unknown-outcome handling, stale work fencing and numeric audit preservation.
- ATS supports provisioned-interview deletion, signed deletion events and polling recovery, application deletion integration, and deletion while the pilot flag is disabled. Unresolved create mappings must be reconciled before deletion.
- Automatic retention remains disabled. No period selected; no claim of provider storage, backups, sent mail or downloaded-copy purge.

## Branches / working trees
- Both remain `codex/ai-interview-integration`. Resumed from service `4ac5ddc` / ATS `7d9031833`; completed ATS deletion workflow committed as `e06dd0e2f`. Service implementation/checkpoints committed under `feat(interview-service): add durable interview deletion`; resolve its final hash with git log.
- Preserve service untracked `tsconfig.tsbuildinfo` and ATS modified `composer.lock`.

## Verification / operations
- Service: 33 database tests on disposable Herd schemas, 59 unit/contract/transport tests (3 DB suites skipped by the unit command), lint and non-incremental TypeScript passed. Mocked providers only.
- ATS: 44 focused integration/client/status tests / 315 assertions and the existing nested application/human-interview deletion test / 9 assertions passed (45 tests / 324 assertions total). Pint passed. Recruiter HTTP deletion is covered.
- Applied additive service migration 003 and ATS migration 2026_09_19_170401 to existing local Herd databases. No existing interview was deleted.
- Earlier Next and dedicated ATS worker PIDs exited outside this task (cause not inferred). Restored Next HTTPS (PIDs 22633/22634) in exec session 73305 using existing Herd certificates. Authenticated capabilities: 200/schema 1.0; unknown deletion status: 404; no active/provisional live attempts.
- No service worker, ATS worker or scheduler was started. No paid provider session, invitation, billing, push, deployment or production config change. Exact-host allowlisting and public IPv4 HTTPS/443 production policy unchanged.

## Pending / exact next safe action
- All required checks and grouped local commits completed. ATS has only unrelated composer.lock modified; service has only unrelated tsconfig.tsbuildinfo untracked. This final checkpoint observation is included by amending the same service commit. No push or pending runtime mutation.
- Both checkpoint files and plan section 18 updated with inventory, workflow, observed migrations/tests and remaining policy gates.
- Next safe action: decide the next lifecycle policy/acceptance slice using plan section 18. Runtime workers remain stopped intentionally; reinspect matching processes and active/pending work before starting any worker.
- Broader remaining policy/acceptance: unresolved provider creations, unknown usage reconciliation, team hard-deletion restrictions, unprovisioned-create deletion, retention policy and backup restore drills; public production webhook acceptance remains deferred.
