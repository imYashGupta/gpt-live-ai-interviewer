# GPT-Live-1 AI Interviewer Prototype

A small Next.js prototype for browser-based technical interviews with two modes.
In AI-led mode, `gpt-live-1` controls the interview dynamically. In Plan & review
mode, GPT-5.6 Luna creates a duration-aware editable question plan before
`gpt-live-1` conducts it. Both use WebRTC for microphone audio and generated
speech, plus Live events and captions.

## Run locally

The current OpenAI Live SDK requires Node.js 22.6 or newer.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Add your server-side `OPENAI_API_KEY` to `.env.local`.
4. Add a shared `APP_PASSCODE`; the app and its API routes fail closed when it is
   missing. Use a strong passcode because this MVP does not rate-limit attempts.
5. Start the app with `npm run dev`.
6. Open [http://localhost:3000](http://localhost:3000) and use headphones for the
   first audio test.

The API key is read only by `POST /api/interview-plan` and
`POST /api/live/session`; it is never returned to the browser. Do not commit
`.env.local`.

The passcode is checked only on the server. Successful access creates a signed,
HttpOnly cookie that expires after seven days. Changing `APP_PASSCODE`
immediately invalidates existing access cookies.

## Current scope

The MVP offers AI-led and Plan & review modes. AI-led mode skips Luna and gives
GPT-Live control over question selection, ordering, and depth. Plan & review mode
generates an editable plan before entering the Live room. Plan sizes are paced
for spoken answers: 3, 5, 7, 9, or 12 core questions for 5, 10, 15, 20, or 30
minutes. Both modes start with a candidate introduction before technical topics.
Adaptive follow-ups are on by default and target roughly 35% of technical topics.

The Live room includes a voice picker with Willow as the default, lightweight
captions, mute/end controls, connection states, and a raw event panel. When the
session ends, the UI shows separate Luna and Live estimates plus the total cost.

Evaluation and backend delegation are intentionally deferred.

## Session logs

Successful Live session creations are recorded in `.data/interviews.sqlite`.
The browser completes the row with final usage when the Live session closes;
interrupted sessions are retained with `ended_without_usage` status. Set
`SQLITE_DATABASE_PATH` to use another persistent location. IP addresses are
read from deployment proxy headers and stored directly in the session log.
