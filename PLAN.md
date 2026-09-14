# GPT-Live-1 AI Interviewer — Implementation Plan

## Goal

Build a small, working browser-based AI interviewer using OpenAI `gpt-live-1`.

The MVP should let a candidate:

1. Open an interview page.
2. Allow microphone access.
3. Click **Start interview**.
4. Speak naturally with an AI interviewer.
5. Interrupt the AI naturally and pause while thinking.
6. See a live transcript.
7. End the interview.
8. Receive a structured interview summary and scorecard.

This is an experiment first. Keep the code simple, understandable, and easy to replace later.

---

## Recommended Stack

Use a single Next.js app for the prototype.

- Next.js + TypeScript
- React
- OpenAI Node SDK
- WebRTC in the browser
- Server-side API routes for all OpenAI secret-key operations
- Tailwind CSS only if it is already convenient; otherwise plain CSS is fine
- In-memory state for v1
- No database for the first prototype

Why Next.js for the prototype: it lets the browser UI and trusted backend routes live in one small repository.

---

## Important Security Rule

Never expose `OPENAI_API_KEY` to browser JavaScript.

The browser creates the WebRTC offer and sends the SDP offer to our backend.

The backend uses the OpenAI SDK / Live API to create the `gpt-live-1` session and returns only the WebRTC answer/session information needed by the browser.

Expected high-level flow:

```text
Browser
  |
  | WebRTC SDP offer
  v
POST /api/live/session
  |
  | OPENAI_API_KEY (server only)
  v
OpenAI Live API
POST /live/sessions
  |
  | SDP answer + live session id
  v
Our backend
  |
  v
Browser applies remote SDP answer
```

OpenAI's current Live API creates WebRTC sessions through `POST /live/sessions` with `session.model = "gpt-live-1"` and `transport.type = "webrtc"`.

---

# MVP Scope

## Screen 1 — Interview Setup

Fields:

- Candidate name
- Role / job title
- Job description
- Interview duration (default 10 minutes)
- Difficulty: Junior / Mid / Senior
- Optional candidate/resume notes

Button:

- Start Interview

For the first version, pre-fill sensible sample data so testing takes one click.

Example:

```text
Candidate: Test Candidate
Role: Senior Laravel Developer
Duration: 10 minutes

Focus areas:
- PHP / Laravel
- SQL / database design
- queues
- APIs
- debugging
- architecture
- communication
```

---

## Screen 2 — Live Interview

UI should contain:

- connection state
  - disconnected
  - connecting
  - connected
  - ended
- AI speaking indicator
- candidate speaking indicator if feasible
- mute/unmute
- end interview button
- elapsed time
- transcript panel
- current interview section

Do not over-design the UI.

The primary goal is to validate conversation quality.

---

# Live Session Responsibilities

`gpt-live-1` handles:

- candidate audio input
- AI voice output
- natural turn-taking
- interruptions
- thinking pauses
- background conversational behavior
- interviewer persona
- short follow-up questions
- transcripts/events exposed by the Live API

The interviewer should NOT constantly praise the candidate or tell them whether answers are correct.

---

# Initial Interviewer Instructions

Use roughly the following frontend/session instructions. Adapt to the exact current Live API schema rather than hardcoding an outdated event format.

```text
You are a professional technical interviewer.

Your job is to conduct a structured but natural interview for the role provided in the interview context.

Conversation rules:
- Speak naturally and professionally.
- Ask one main question at a time.
- Keep spoken questions concise.
- Give the candidate time to think.
- Do not interrupt normal thinking pauses.
- Allow the candidate to interrupt you.
- Do not reveal scores during the interview.
- Do not say whether an answer is correct or incorrect.
- Avoid excessive praise such as "great answer" after every response.
- Ask useful follow-up questions when the candidate's answer is shallow, ambiguous, or interesting.
- Never answer the technical question for the candidate unless the interview has ended.
- Stay within the requested interview topics.
- Gradually increase depth based on the candidate's answers.

Interview flow:
1. Brief introduction.
2. Ask the candidate to introduce themselves.
3. Ask role-specific technical questions.
4. Ask follow-up questions based on previous answers.
5. Include at least one practical/debugging scenario.
6. Include one architecture/system-design question if appropriate for senior roles.
7. Finish with a short closing.

When there are roughly 60 seconds remaining, begin wrapping up naturally.
```

Inject interview setup into the session instructions, for example:

```text
ROLE: Senior Laravel Developer
LEVEL: Senior
DURATION: 10 minutes
JOB DESCRIPTION: ...
CANDIDATE NOTES: ...
```

---

# WebRTC Connection Plan

## Browser

Create:

```ts
const pc = new RTCPeerConnection();
```

Request the microphone:

```ts
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
```

Add microphone tracks to the peer connection.

Create an `<audio autoplay>` element or equivalent and attach the incoming remote stream so the user can hear GPT-Live-1.

Create a WebRTC data channel for supported Live control/events.

Create the local offer:

```ts
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

Send `offer.sdp` plus the interview configuration to:

```text
POST /api/live/session
```

Backend returns the OpenAI WebRTC SDP answer.

Apply it:

```ts
await pc.setRemoteDescription({
  type: "answer",
  sdp: response.sdp
});
```

Wait for the current Live API's `session.started` signal/event before sending optional session commands.

Important: follow the current SDK/API types while implementing. GPT-Live-1 is new and event names/configuration may evolve.

---

# Backend Route

Create:

```text
POST /api/live/session
```

Request body:

```json
{
  "sdp": "browser SDP offer",
  "interview": {
    "candidateName": "Test Candidate",
    "role": "Senior Laravel Developer",
    "jobDescription": "...",
    "durationMinutes": 10,
    "difficulty": "senior",
    "candidateNotes": "..."
  }
}
```

Backend responsibilities:

1. Validate required input.
2. Build the interviewer instructions.
3. Call the current OpenAI Live session API using `OPENAI_API_KEY`.
4. Set model to `gpt-live-1`.
5. Use WebRTC transport with the browser SDP offer.
6. Return the SDP answer and session id.
7. Never return the OpenAI API key.

Use the official OpenAI SDK if its currently installed/latest version supports `client.live.create(...)`.

Conceptually:

```ts
const live = await openai.live.create({
  session: {
    model: "gpt-live-1",
    // current supported Live configuration + instructions
  },
  transport: {
    type: "webrtc",
    sdp,
  },
});
```

Do not blindly copy this object if the installed SDK types indicate a newer exact schema. Prefer the current SDK/API reference.

---

# Transcript

Capture both sides of the interview when supported by the current Live events:

```ts
interface TranscriptEntry {
  id: string;
  speaker: "candidate" | "interviewer";
  text: string;
  timestampMs: number;
}
```

Show the transcript in the UI as it accumulates.

The OpenAI launch information states GPT-Live-1 natively provides ASR transcripts and response text, so do not add a separate Whisper transcription pipeline for this MVP unless Live transcript events prove insufficient.

Keep raw Live events available behind a debug toggle because GPT-Live-1 is new and event inspection will help development.

---

# Interview State

For MVP, maintain locally/server-side:

```ts
interface InterviewState {
  id: string;
  sessionId?: string;
  status: "idle" | "connecting" | "active" | "ended" | "error";
  startedAt?: string;
  endedAt?: string;
  transcript: TranscriptEntry[];
  config: InterviewConfig;
}
```

No persistence required initially.

Refresh can lose the interview during v1.

---

# End Interview

End can happen when:

- candidate clicks End Interview
- requested duration expires
- connection fails permanently

On end:

1. Stop microphone tracks.
2. Close WebRTC connection cleanly.
3. Preserve transcript in React state.
4. Send transcript + interview configuration to `/api/interview/evaluate`.
5. Display resulting scorecard.

If the Live API exposes a clean session close command/event, use it.

---

# Evaluation Endpoint

Create:

```text
POST /api/interview/evaluate
```

This should use a text reasoning model, NOT GPT-Live-1.

Choose a currently available cost-effective text model unless another model is configured through `.env`.

Environment variable:

```text
INTERVIEW_EVALUATION_MODEL=<model name>
```

Evaluation request contains:

- role
- job description
- difficulty
- transcript
- candidate notes

Return strict structured JSON.

Suggested schema:

```json
{
  "overallScore": 7.4,
  "recommendation": "proceed",
  "confidence": 0.83,
  "summary": "...",
  "competencies": [
    {
      "name": "Laravel",
      "score": 8,
      "evidence": [
        "Candidate explained queue workers and retry behavior."
      ],
      "concerns": []
    }
  ],
  "strengths": [],
  "concerns": [],
  "followUpTopics": []
}
```

Recommendation enum:

```text
strong_proceed
proceed
mixed
no_proceed
insufficient_evidence
```

Important:

Scores must be grounded in transcript evidence.

Do not infer protected/sensitive characteristics.

Do not evaluate accent, perceived ethnicity, gender, age, disability, or similar traits.

Do not use vocal characteristics as hiring evidence.

Evaluate only job-relevant content demonstrated during the interview.

---

# Evaluation Prompt

Use something close to:

```text
You are evaluating a technical interview.

Evaluate only evidence demonstrated in the transcript against the supplied role and job description.

Rules:
- Do not infer skills that were not demonstrated.
- Mark areas with insufficient evidence explicitly.
- Every competency score must contain transcript-grounded evidence.
- Do not evaluate accent, speaking style unrelated to the job, age, gender, ethnicity, disability, nationality, religion, or other protected/sensitive traits.
- Communication scores should evaluate job-relevant clarity only.
- A confident but incorrect answer should score worse than an uncertain but technically correct answer.
- Return only the requested structured JSON.
```

---

# Phase 2 — Backend Delegation

Do NOT block the first prototype on this.

Once basic GPT-Live interviewing works, add GPT-Live backend delegation / sideband handling.

Goal:

```text
Candidate answer
   |
   v
GPT-Live-1
   |
   | delegates decision
   v
Backend interview reasoner
   |
   | analyzes evidence + coverage
   v
returns next-question guidance
   |
   v
GPT-Live-1 asks it naturally
```

The backend interview reasoner can maintain coverage like:

```json
{
  "laravel": { "evidence": 0.8, "estimatedScore": 8 },
  "database": { "evidence": 0.5, "estimatedScore": 6 },
  "architecture": { "evidence": 0.2, "estimatedScore": null }
}
```

Then it can tell GPT-Live:

```text
We already have strong Laravel evidence.
Do not ask another Laravel fundamentals question.
Probe database concurrency next.
Ask about a real incident involving transactions or locking.
```

OpenAI's current Live API supports delegation to the application / Responses backend, and trusted sideband connections can control the same Live session. Use those mechanisms in Phase 2 rather than inventing a second voice pipeline.

---

# Suggested Project Structure

```text
gpt-live-ai-interviewer/
├── app/
│   ├── page.tsx
│   ├── interview/
│   │   └── page.tsx
│   └── api/
│       ├── live/
│       │   └── session/
│       │       └── route.ts
│       └── interview/
│           └── evaluate/
│               └── route.ts
├── components/
│   ├── InterviewSetup.tsx
│   ├── InterviewRoom.tsx
│   ├── Transcript.tsx
│   └── Scorecard.tsx
├── lib/
│   ├── openai.ts
│   ├── live.ts
│   ├── interview-prompt.ts
│   ├── evaluation-prompt.ts
│   └── types.ts
├── .env.example
├── README.md
└── PLAN.md
```

Do not create unnecessary abstractions during the first pass.

---

# Environment Variables

```env
OPENAI_API_KEY=
INTERVIEW_EVALUATION_MODEL=
```

Keep `.env.local` ignored by git.

---

# Implementation Order for Codex

## Milestone 1 — Project bootstrap

- Create Next.js TypeScript project.
- Add OpenAI SDK.
- Create `.env.example`.
- Add basic setup form.
- Add interview room layout.

Done when the app runs locally and setup data reaches the interview page.

## Milestone 2 — GPT-Live connection

- Ask browser for microphone permission.
- Create WebRTC peer connection.
- Create SDP offer.
- Add `/api/live/session`.
- Server creates `gpt-live-1` session.
- Apply SDP answer.
- Play incoming AI audio.

Done when the candidate can have a basic spoken conversation with GPT-Live-1.

DO NOT continue until this works reliably.

## Milestone 3 — Interview behavior

- Inject role/JD/interview instructions.
- AI introduces itself.
- AI asks candidate introduction.
- AI asks technical questions.
- Test interruption handling.
- Test 3–5 second thinking pauses.
- Test candidate speaking while AI is speaking.

Done when the interaction feels like an interview rather than voice chat.

## Milestone 4 — Transcript

- Listen for current Live transcript/text events.
- Render candidate transcript.
- Render interviewer transcript.
- Add debug event console toggle.

Done when the complete conversation is readable after the interview.

## Milestone 5 — End + evaluation

- End interview button.
- Timer.
- Evaluation endpoint.
- Structured scorecard.
- Evidence per score.

Done when a completed interview produces a useful review page.

## Milestone 6 — Polish

- reconnect/error states
- permission errors
- loading states
- mute
- timer warning
- mobile layout
- basic accessibility

---

# Testing Checklist

Test with headphones first to avoid echo.

### Connection

- [ ] microphone permission accepted
- [ ] microphone permission denied handled
- [ ] GPT voice audible
- [ ] reconnect/error state understandable
- [ ] API key never present in browser source/network response

### Conversation

- [ ] candidate can interrupt AI
- [ ] AI doesn't interrupt every short pause
- [ ] 3–5 second thinking pause is tolerated
- [ ] AI doesn't repeatedly praise candidate
- [ ] one question at a time
- [ ] follow-up questions reference candidate's answer
- [ ] interview remains role-specific
- [ ] AI doesn't reveal evaluation during interview

### Transcript

- [ ] candidate text captured
- [ ] interviewer text captured
- [ ] partial events don't create duplicate final text
- [ ] transcript survives until evaluation

### Evaluation

- [ ] score contains evidence
- [ ] missing evidence is marked as missing
- [ ] no demographic/sensitive-trait scoring
- [ ] scorecard JSON validates

---

# Things NOT to Build Yet

Do not spend MVP time on:

- authentication
- recruiter accounts
- multi-tenant companies
- billing
- email invites
- calendar scheduling
- database persistence
- video recording
- anti-cheating detection
- coding IDE
- resume parser
- production analytics
- telephony
- complicated agent framework

First prove that GPT-Live-1 can conduct a good interview.

---

# Success Criteria

The prototype is successful if:

1. Candidate can talk naturally for 10 minutes.
2. Interruptions work naturally.
3. Thinking pauses do not constantly trigger premature AI responses.
4. AI asks relevant follow-ups.
5. Transcript is usable.
6. Final evaluation cites real evidence.
7. Total setup remains small enough that we understand every major component.

---

# Expected Cost During Testing

The current GPT-Live-1 API launch price is $0.05/minute for the front-end voice layer, excluding the separate backend/evaluation model.

Approximate voice-layer test costs:

```text
5 minutes  = $0.25
10 minutes = $0.50
20 minutes = $1.00
30 minutes = $1.50
```

So use 5-minute test interviews during development.

---

# Codex Rule

When the current OpenAI SDK types or official Live API documentation disagree with this plan, follow the current official API/SDK.

GPT-Live-1 was released very recently and the implementation should be type-driven rather than forcing old Realtime API examples onto the new Live API.
