import type { PoolClient } from "pg";
import { transaction } from "./postgres.ts";
import { ServiceError } from "./security.ts";
import type { InterviewService } from "./service.ts";
import { candidateAttempt, missingChunks, recordingChunks, type RecordingRow } from "./recordings.ts";

export const integrityEventTypes = ["tab_hidden","tab_visible","window_blur","window_focus","camera_lost","recording_unavailable"] as const;
export type IntegrityEventType = typeof integrityEventTypes[number];
const maxBatch = 50;
// Bounds storage per attempt; a browser flapping focus cannot fill the table.
const maxEventsPerAttempt = 1000;
const maxOffsetMs = 7_200_000;
// Matches the browser recorder's chunk length; used to estimate missing video time.
const chunkSeconds = 10;

export interface IntegrityEvent { type: IntegrityEventType; offset_ms: number }

function parseEvents(input: unknown): IntegrityEvent[] {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "events")) throw new ServiceError(422,"validation_failed");
  const { events } = input as { events?: unknown };
  if (!Array.isArray(events) || !events.length || events.length > maxBatch) throw new ServiceError(422,"validation_failed");
  return events.map(event => {
    if (!event || typeof event !== "object" || Array.isArray(event) || Object.keys(event).some(k => !["type","offset_ms"].includes(k))) throw new ServiceError(422,"validation_failed");
    const { type, offset_ms } = event as { type?: unknown; offset_ms?: unknown };
    if (!integrityEventTypes.includes(type as IntegrityEventType) || typeof offset_ms !== "number" || !Number.isInteger(offset_ms)
      || offset_ms < 0 || offset_ms > maxOffsetMs) throw new ServiceError(422,"validation_failed");
    return { type: type as IntegrityEventType, offset_ms };
  });
}

/** Stores a batch of browser signals for the candidate's own attempt. Events past the per-attempt cap are dropped. */
export async function recordIntegrityEvents(service: InterviewService, token: string | null, input: unknown) {
  const events = parseEvents(input);
  return transaction(service.pool,async db => {
    const { attempt } = await candidateAttempt(db,token);
    const stored = (await db.query("SELECT count(*)::int AS n FROM service_integrity_events WHERE attempt_id=$1",[attempt.id])).rows[0].n as number;
    const accepted = events.slice(0,Math.max(0,maxEventsPerAttempt - stored));
    if (accepted.length) {
      await db.query(`INSERT INTO service_integrity_events(attempt_id,type,offset_ms)
        SELECT $1,e.type,e.offset_ms FROM jsonb_to_recordset($2::jsonb) AS e(type text,offset_ms integer)`,[attempt.id,JSON.stringify(accepted)]);
    }
    return { accepted: accepted.length };
  });
}

/** Total time between each start event and the next matching end event; an unmatched start runs to the end of the attempt. */
function closedSpans(events: IntegrityEvent[], start: IntegrityEventType, end: IntegrityEventType, attemptMs: number) {
  let count = 0, total = 0, openedAt: number | null = null;
  for (const event of events) {
    if (event.type === start && openedAt === null) { count++; openedAt = event.offset_ms; }
    else if (event.type === end && openedAt !== null) { total += Math.max(0,event.offset_ms - openedAt); openedAt = null; }
  }
  if (openedAt !== null) total += Math.max(0,attemptMs - openedAt);
  return { count, seconds: Math.round(total / 1000) };
}

/**
 * Reviewer-facing signals for one attempt. These are prompts for a human to look at the recording, not findings:
 * a permission prompt, a notification or a slow connection can cause the same signals as cheating.
 */
export async function integritySummary(db: PoolClient, attemptId: string) {
  const attempt = (await db.query<{ started_at: Date; ended_at: Date | null; deadline_at: Date }>(
    "SELECT started_at,ended_at,deadline_at FROM service_attempts WHERE id=$1",[attemptId])).rows[0];
  if (!attempt) throw new ServiceError(404,"not_found");
  const attemptMs = Math.max(0,(attempt.ended_at ?? attempt.deadline_at).getTime() - attempt.started_at.getTime());
  const events = (await db.query<IntegrityEvent>("SELECT type,offset_ms FROM service_integrity_events WHERE attempt_id=$1 ORDER BY offset_ms,id",
    [attemptId])).rows;
  const recording = (await db.query<RecordingRow>("SELECT * FROM service_recordings WHERE attempt_id=$1",[attemptId])).rows[0];
  let video: { status: string; missing_chunks: number; missing_seconds_estimate: number } | null = null;
  if (recording) {
    const chunks = await recordingChunks(db,recording.id);
    const highest = chunks.filter(c => c.confirmed_at).reduce((max,c) => Math.max(max,c.sequence),-1);
    const missing = missingChunks(chunks).length + chunks.filter(c => !c.confirmed_at && c.sequence > highest).length;
    video = { status: recording.status, missing_chunks: missing, missing_seconds_estimate: missing * chunkSeconds };
  }
  return {
    recording: video,
    recording_unavailable: events.some(e => e.type === "recording_unavailable"),
    tab_hidden: closedSpans(events,"tab_hidden","tab_visible",attemptMs),
    focus_lost: closedSpans(events,"window_blur","window_focus",attemptMs),
    camera_lost: events.filter(e => e.type === "camera_lost").length,
    events: events.slice(0,200),
  };
}
