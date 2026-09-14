# GPT-Live-1 AI Interviewer Prototype

A small Next.js prototype for a browser-based technical interview. GPT-5.6 Luna
creates a duration-aware question plan for review, then `gpt-live-1` conducts the
approved plan over WebRTC with microphone audio, generated speech, events, and
captions.

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

The MVP flow lets a reviewer enter a role and job description, generate an
editable interview plan, and approve it before entering the Live room. Plan sizes
are paced for spoken answers: 3, 5, 7, 9, or 12 core questions for 5, 10, 15, 20,
or 30 minutes. Adaptive follow-ups are on by default and are planned for roughly
35% of the core questions.

The Live room includes a voice picker with Willow as the default, lightweight
captions, mute/end controls, connection states, and a raw event panel. When the
session ends, the UI shows separate Luna and Live estimates plus the total cost.

Evaluation, persistence, and backend delegation are intentionally deferred.
