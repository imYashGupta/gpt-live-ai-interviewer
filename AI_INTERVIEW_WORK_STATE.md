# AI interview integration: resume checkpoint

Updated: 2026-09-18. This is an observed-state checkpoint, not permission to expand task scope. Read NEXT_TASK_HANDOFF.md for architecture, setup and detailed acceptance evidence.

## Current objective and status

- Latest user request: make usage-limit interruptions recoverable without losing track of work.
- Recovery instructions and this checkpoint are installed in the two project instruction chains.
- Product fixes are complete and committed: server-controlled pacing/closing and graceful candidate End.
- Recommended next product task: Phase 3 report delivery and outage/polling recovery acceptance. It has not started; the user plans to continue it in a new chat.

## Repositories and verified commits

- `/Users/yashgupta/WORK/gpt-live-ai-interviewer`, branch `codex/ai-interview-integration`.
  - `9d5652e`: timing, closing speech and intentional completion fixes.
  - `f0c7b1e`: detailed next-task handoff.
- `/Users/yashgupta/Laravel/recooty`, same branch.
  - `63e6e3d3d`: matching timing/completion verification notes.
  - `065b512e2`: resume checkpoint instructions.
- Unrelated changes to preserve: service `tsconfig.tsbuildinfo` (untracked), Recooty `composer.lock` (modified).

## Verification already completed

- 55 service unit/contract/transport tests; 24 integration tests on existing Herd PostgreSQL.
- Lint and TypeScript passed. Final transport guards were checked separately afterward.
- Two-minute generated-speech interview completed automatically with ready assessment and settled usage.
- Separate generated-speech attempt ended through the candidate button at about 47 seconds: completed, candidate_end, assessment ready, usage settled.
- No customer charges, invitation email, push or deployment. Historical interrupted attempts remain unchanged.

## Pending operations / environment

- No live test or pending destructive/external operation was left running at the last check.
- Development services were left running: Next HTTPS dev server; service worker last observed PID 90484; dedicated ATS queue worker last observed PID 7019. Recheck process identity and active attempts before any restart; PIDs and tool session handles are not durable.
- Service origin `https://interview-bot.test:3000`; ATS `http://recooty.test`; CloudTech team 1 only.
- The earlier automatic approval usage-limit block cleared after the user resumed. Do not assume a new rejection can be bypassed.
- Service checkpoint/instruction installation is ready for its grouped documentation commit. Check Git history for `docs: add durable integration resume checkpoint` before retrying; this file is included in that commit.

## Next safe action

1. When the user starts the next product task: read this checkpoint, NEXT_TASK_HANDOFF.md and applicable AGENTS.md files; check current git state and verify the documentation commit above.
2. Inspect existing Recooty result delivery/reconciliation before implementing changes. Use existing synthetic results where possible. Keep paid billing disabled and use Herd PostgreSQL.
3. Update this file to the actual active objective before beginning new work. Clear resolved pending operations rather than keeping a growing log.
