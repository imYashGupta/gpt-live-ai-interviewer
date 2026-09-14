# Prompt for Codex

Read `PLAN.md` completely before writing code.

Build the MVP described there in this repository.

Start with Milestones 1 and 2 only. The first objective is a reliable browser-to-`gpt-live-1` WebRTC voice conversation. Do not implement the evaluation system or advanced backend delegation until basic live audio works.

Requirements:

- Next.js + TypeScript.
- Use the current OpenAI Node SDK and its current Live API types.
- Use `gpt-live-1`.
- Browser audio transport should use WebRTC.
- Keep `OPENAI_API_KEY` server-side only.
- Session creation should happen through a backend route using the current Live session API (`POST /live/sessions` / SDK equivalent).
- Add clear connection/error states.
- Add a small debug panel for Live data-channel events.
- Do not copy obsolete GPT Realtime API code if the new Live API differs.
- Keep dependencies minimal.
- Keep code straightforward; this is an experimental prototype.

After Milestone 2 works, stop and report:

1. files created/changed,
2. how to run it,
3. where to put `OPENAI_API_KEY`,
4. how the WebRTC flow works,
5. any GPT-Live-1 API details that differed from `PLAN.md`,
6. exact manual steps for testing microphone, AI audio, interruption, and pauses.

Do not expose secrets in logs, frontend code, or committed files.
