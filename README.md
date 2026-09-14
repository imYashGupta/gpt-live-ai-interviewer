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
4. Start the app with `npm run dev`.
5. Open [http://localhost:3000](http://localhost:3000) and use headphones for the
   first audio test.

The API key is read only by `POST /api/interview-plan` and
`POST /api/live/session`; it is never returned to the browser. Do not commit
`.env.local`.

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

Evaluation, persistence, and backend delegation are intentionally deferred.
