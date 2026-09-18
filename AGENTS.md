<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Durable checkpoints for AI interview integration

- When working on the Recooty integration, read `AI_INTERVIEW_WORK_STATE.md` at task start and after a resume, context reset, or user request to continue. Read `NEXT_TASK_HANDOFF.md` for broader background when needed.
- Keep `AI_INTERVIEW_WORK_STATE.md` short and current: objective, branch/repositories, last completed step, changed-but-unverified work, checks and results, pending operations, known blockers, and the exact next safe action. Distinguish completed work from recommended future work.
- Update the checkpoint after each meaningful implementation/verification milestone, before a long-running or externally mutating operation, and before handing back or switching tasks. For an operation about to run, record it as pending first, then record its observed result. Do not wait until the usage limit is exhausted.
- If usage-limit information is available during sustained work, check it occasionally before a substantial batch. When near exhaustion, checkpoint before starting the batch. Do not promise a final save or automatic wake-up after a hard limit; neither is guaranteed.
- On resume, reconcile the checkpoint with current git status/diffs, recent commits, and relevant process/job/service state. Commands may have completed or remained running after the agent stopped. Verify outcomes before retrying migrations, API mutations, provider sessions, invitations, commits, or other effects. Reuse existing idempotency identities where appropriate.
- Never reset/discard uncommitted changes to recover context. Preserve unrelated user work. Do not fabricate a stop reason or treat an absent command result as proof the command failed. A blocked approval remains blocked until resolved; checkpoints do not bypass approval rules.
- Keep credentials, invitation/session tokens and candidate transcripts out of checkpoint files. Reference private config locations and opaque test/job IDs only when needed. Do not overwrite another task's checkpoint; these files are scoped to this integration.
- Commit checkpoints with related completed work under the user's existing commit guidelines; do not create a separate commit for every update. Keep the detailed handoff current at phase boundaries.
