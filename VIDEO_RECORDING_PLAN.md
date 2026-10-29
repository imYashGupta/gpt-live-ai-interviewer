# Interview video recording plan

Goal: store the full interview (candidate camera, candidate voice and AI interviewer voice) in private S3 so recruiters
can review it for cheating. Screen recording is out of scope for now.

Branch: `feat/interview-video-recording` (from `main`). Each step is one commit and is tested before the next starts.

## Approach

The candidate's browser records with `MediaRecorder` and uploads ~10-second chunks straight to S3 through short-lived
presigned POST links issued by the service. Media never passes through the app server or the worker, so live interview
capacity is unchanged. No LiveKit or media relay. The service records every chunk it issued and confirmed, so gaps are
detectable.

## Steps

| # | Step | Test |
|---|---|---|
| 1 | S3 storage module: config from env, object key layout, presigned POST upload (size and type enforced by S3), presigned GET, delete; `service:recording-check` smoke script; bucket setup docs | Unit tests (offline presigning, key validation, config errors); smoke script against the real bucket |
| 2 | Migration `006_recordings.sql`: recordings and recording chunks | Database tests: create, chunk idempotency, tenant isolation |
| 3 | Candidate upload endpoints: issue an upload link per chunk, confirm a chunk, all behind the candidate session | Security tests: wrong token, other interview, after end, duplicate chunk, oversize |
| 4 | Consent text and camera gate: interview cannot start without camera and microphone | Browser test with Chrome fake media devices; manual Chrome and Safari |
| 5 | Browser recording: mix candidate mic and AI audio with the camera, record, upload chunks with retry | Browser test confirms chunks land in S3; manual 2-minute interview |
| 6 | Finalize: worker job joins chunks into one file after the interview | Joined file plays through and its duration matches |
| 7 | Integrity signals: missing chunks and gaps, tab switches, focus loss, fullscreen exit, shown in the report | Tests simulate gaps and tab switches |
| 8 | Playback and deletion: short-lived playback link in the report and artifacts endpoint; interview deletion removes S3 objects | Authorization tests; objects gone after deletion |

## Open decisions

- Before step 4: consent wording and retention period (for example 30, 60 or 90 days).
- Before step 7: what happens when recording stops mid-interview (flag only, pause, or end).
