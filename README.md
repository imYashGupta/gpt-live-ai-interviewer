# GPT-Live-1 AI Interviewer Prototype

A small Next.js prototype for a browser-based technical interview with OpenAI
`gpt-live-1`. It uses WebRTC for microphone input and generated speech, plus the
Live data channel for session events and captions.

## Run locally

The current OpenAI Live SDK requires Node.js 22.6 or newer.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Add your server-side `OPENAI_API_KEY` to `.env.local`.
4. Start the app with `npm run dev`.
5. Open [http://localhost:3000](http://localhost:3000) and use headphones for the
   first audio test.

The API key is read only by `POST /api/live/session`; it is never returned to the
browser. Do not commit `.env.local`.

## Current scope

This implements Milestones 1 and 2 from `PLAN.md`: the setup experience and the
Live WebRTC connection. It also includes lightweight captions, mute/end controls,
connection states, and a raw event panel to make the new API easier to inspect.

Evaluation, persistence, and backend delegation are intentionally deferred.
