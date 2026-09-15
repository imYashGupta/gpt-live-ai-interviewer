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
   missing. Use a strong passcode.
5. Start the app with `npm run dev`.
6. Open [http://localhost:3000](http://localhost:3000) and use headphones for the
   first audio test.

The API key is read only by `POST /api/interview-plan`,
`POST /api/live/session`, and `POST /api/interviews/report`; it is never returned to the browser. Do not commit
`.env.local`.

The passcode is checked only on the server. Successful access creates a signed,
HttpOnly cookie that expires after seven days. Changing `APP_PASSCODE`
immediately invalidates existing access cookies. Five failed attempts from one
IP address within 15 minutes temporarily block further attempts from that IP.

## Current scope

The MVP offers AI-led and Plan & review modes. AI-led mode skips Luna and gives
GPT-Live control over question selection, ordering, and depth. Plan & review mode
generates an editable plan before entering the Live room. Plan sizes are paced
for spoken answers: 3, 5, 7, 9, or 12 core questions for 5, 10, 15, 20, or 30
minutes. Both modes start with a candidate introduction before technical topics.
Adaptive follow-ups are on by default and target roughly 35% of technical topics.

The Live room includes a voice picker with Willow as the default, lightweight
captions, mute/end controls, connection states, and a raw event panel. When the
session ends, the UI generates an interview report and shows separate question-plan,
Live session, and report-generation estimates plus the total cost.

## Interview reports

After either interview mode ends, GPT-5.6 Luna assesses the captured transcript
using structured output. The report includes:

- Answer accuracy, technical knowledge, problem solving, communication, and
  confidence expressed in the content of answers.
- A skill profile chart and a clickable answer-quality chart, with transcript
  evidence, strengths, development areas, and practical next steps.
- An overall score averaging the four core skills, excluding expressed confidence.
  It requires at least two assessed answers and evidence for every core skill.
  Insufficient evidence is shown as unassessed, never as a zero score.
- A saved report at `/interviews/<interview-id>/report` and a **Print / save PDF**
  button. Saved reports require the app passcode. Open evidence sections before
  printing to include their supporting excerpts.

These are AI-generated practice assessments, not hiring decisions or validated
measurements of personality. Confidence refers to the wording and reasoning in
answers; audio tone, emotion, body language, and internal confidence are not assessed.
The report identifies limited coverage and uses only questions actually discussed.

Report generation uses the existing server API key and adds a separate Luna token
cost. Failed requests can be retried with the transcript still in the browser;
completed reports are reused without another generation request. Interviews created
before this feature do not have the stored context needed for a report.

Run `node --test tests/interview-report.test.mjs` for evidence-validation and
scoring tests, `npm run lint`, and `npm run build` for application checks.
After building, run `node tests/report-integration.mjs` to check the API flow,
saved-report access, retry behavior, and cost accounting with a local OpenAI stub
and temporary database. This test uses local port 3112 by default and makes no
paid OpenAI calls.

Backend delegation during the live interview remains deferred.

## Session logs

Successful Live session creations are recorded in `.data/interviews.sqlite`.
The browser completes the row with final usage when the Live session closes;
interrupted sessions are retained with `ended_without_usage` status. Set
`SQLITE_DATABASE_PATH` to use another persistent location. IP addresses are
read from deployment proxy headers and stored directly in the session log.
New sessions also store report context (candidate name, role, job description, and
interview settings, excluding candidate notes). Completed reports and their text
transcripts are stored in the `interview_reports` table in the same database. No
audio recording is stored. Keep the database private; anyone with the shared app
passcode and a report URL can read that report. Closing the tab before generation
starts does not generate a report in the background.
