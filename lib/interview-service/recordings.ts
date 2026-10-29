import type { PoolClient } from "pg";
import { attemptPrefix, chunkKey, maxChunkSequence, recordingType, type RecordingType } from "./recording-storage.ts";
import { newId, ServiceError } from "./security.ts";
import { transaction } from "./postgres.ts";
import { candidateRow } from "./candidate.ts";
import type { InterviewService } from "./service.ts";

export interface RecordingRow {
  id: string; account_id: string; interview_id: string; attempt_id: string; object_prefix: string;
  content_type: RecordingType; consent_version: string; status: string; object_key: string | null;
  object_bytes: string | null; started_at: Date; ended_at: Date | null; deleted_at: Date | null;
}
export interface ChunkRow { recording_id: string; sequence: number; object_key: string; issued_at: Date; confirmed_at: Date | null; bytes: string | null }

/**
 * Opens the attempt's recording, or returns it when the browser retries. The type is fixed by the first call:
 * one recording's chunks must come from one recorder to be joined later.
 */
export async function openRecording(db: PoolClient, attempt: { accountId: string; interviewId: string; attemptId: string },
  storagePrefix: string, type: string, consentVersion: string): Promise<RecordingRow> {
  const contentType = recordingType(type);
  if (!/^[a-z0-9_.-]{1,64}$/.test(consentVersion)) throw new ServiceError(422,"validation_failed");
  const prefix = attemptPrefix(storagePrefix,attempt.accountId,attempt.interviewId,attempt.attemptId);
  await db.query(`INSERT INTO service_recordings(id,account_id,interview_id,attempt_id,object_prefix,content_type,consent_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (attempt_id) DO NOTHING`,
  [newId("rec"),attempt.accountId,attempt.interviewId,attempt.attemptId,prefix,contentType,consentVersion]);
  const row = (await db.query<RecordingRow>("SELECT * FROM service_recordings WHERE attempt_id=$1 FOR UPDATE",[attempt.attemptId])).rows[0];
  if (row.account_id !== attempt.accountId || row.interview_id !== attempt.interviewId) throw new ServiceError(409,"recording_conflict");
  if (row.content_type !== contentType) throw new ServiceError(409,"recording_type_changed");
  return row;
}

/** Tenant-scoped lookup: another account's interview reads as missing. */
export async function recordingForInterview(db: PoolClient, accountId: string, interviewId: string): Promise<RecordingRow | null> {
  return (await db.query<RecordingRow>("SELECT * FROM service_recordings WHERE account_id=$1 AND interview_id=$2 AND deleted_at IS NULL",
    [accountId,interviewId])).rows[0] ?? null;
}

async function lockRecording(db: PoolClient, recordingId: string) {
  const row = (await db.query<RecordingRow>("SELECT * FROM service_recordings WHERE id=$1 FOR UPDATE",[recordingId])).rows[0];
  if (!row || row.deleted_at) throw new ServiceError(404,"not_found");
  return row;
}
function assertSequence(sequence: number) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > maxChunkSequence) throw new ServiceError(422,"validation_failed");
}

/** Reserves the object key for one chunk. Re-issuing an unconfirmed chunk returns the same key so a failed upload can retry. */
export async function issueChunk(db: PoolClient, recordingId: string, sequence: number): Promise<ChunkRow> {
  assertSequence(sequence);
  const recording = await lockRecording(db,recordingId);
  if (recording.status !== "recording") throw new ServiceError(409,"recording_closed");
  const key = chunkKey(recording.object_prefix,sequence,recording.content_type);
  const chunk = (await db.query<ChunkRow>(`INSERT INTO service_recording_chunks(recording_id,sequence,object_key) VALUES ($1,$2,$3)
    ON CONFLICT (recording_id,sequence) DO UPDATE SET issued_at=CASE WHEN service_recording_chunks.confirmed_at IS NULL
    THEN now() ELSE service_recording_chunks.issued_at END RETURNING *`,[recordingId,sequence,key])).rows[0];
  if (chunk.confirmed_at) throw new ServiceError(409,"chunk_already_uploaded");
  return chunk;
}

/** Records the size S3 reports for an issued chunk. Confirming again with the same size is a no-op. */
export async function confirmChunk(db: PoolClient, recordingId: string, sequence: number, bytes: number): Promise<ChunkRow> {
  assertSequence(sequence);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new ServiceError(422,"validation_failed");
  await lockRecording(db,recordingId);
  const chunk = (await db.query<ChunkRow>("SELECT * FROM service_recording_chunks WHERE recording_id=$1 AND sequence=$2 FOR UPDATE",
    [recordingId,sequence])).rows[0];
  if (!chunk) throw new ServiceError(404,"chunk_not_issued");
  if (chunk.confirmed_at) {
    if (Number(chunk.bytes) !== bytes) throw new ServiceError(409,"chunk_size_mismatch");
    return chunk;
  }
  return (await db.query<ChunkRow>("UPDATE service_recording_chunks SET confirmed_at=now(),bytes=$3 WHERE recording_id=$1 AND sequence=$2 RETURNING *",
    [recordingId,sequence,bytes])).rows[0];
}

export async function recordingChunks(db: PoolClient, recordingId: string): Promise<ChunkRow[]> {
  return (await db.query<ChunkRow>("SELECT * FROM service_recording_chunks WHERE recording_id=$1 ORDER BY sequence",[recordingId])).rows;
}

/** Sequences missing from the confirmed run 0..highest confirmed. Issued but unconfirmed chunks count as missing. */
export function missingChunks(chunks: Pick<ChunkRow,"sequence" | "confirmed_at">[]): number[] {
  const confirmed = new Set(chunks.filter(c => c.confirmed_at).map(c => c.sequence));
  if (!confirmed.size) return [];
  const missing: number[] = [];
  const highest = [...confirmed].reduce((a,b) => Math.max(a,b));
  for (let sequence = 0; sequence < highest; sequence++) if (!confirmed.has(sequence)) missing.push(sequence);
  return missing;
}

/** The consent text version the candidate page shows before recording; bump it whenever that text changes. */
export const recordingConsentVersion = "video_v1";
// The last chunk is uploaded after the recorder stops, which can be shortly after the attempt ends.
const uploadGraceSeconds = 300;

function storage(service: InterviewService) {
  if (!service.recording) throw new ServiceError(409,"recording_disabled");
  return service.recording;
}
/** The candidate's own attempt and its recording, or an error when uploads are no longer accepted. */
async function candidateAttempt(db: PoolClient, token: string | null) {
  const row = await candidateRow(db,token,true);
  if (!row.attempt_id || !["in_progress","completed","interrupted"].includes(row.execution_status)) throw new ServiceError(409,"not_started");
  const attempt = (await db.query<{ id: string; ended_at: Date | null; deadline_at: Date }>(
    "SELECT id,ended_at,deadline_at FROM service_attempts WHERE id=$1",[row.attempt_id])).rows[0];
  const closes = Math.min((attempt.ended_at ?? attempt.deadline_at).getTime(),attempt.deadline_at.getTime()) + uploadGraceSeconds * 1000;
  if (Date.now() > closes) throw new ServiceError(409,"recording_closed");
  return { row, attempt };
}
async function candidateRecording(db: PoolClient, token: string | null) {
  const { row, attempt } = await candidateAttempt(db,token);
  const recording = (await db.query<RecordingRow>("SELECT * FROM service_recordings WHERE attempt_id=$1",[attempt.id])).rows[0];
  if (!recording) throw new ServiceError(409,"recording_not_started");
  return { row, recording };
}
function chunkSequence(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "sequence")) throw new ServiceError(422,"validation_failed");
  const { sequence } = input as { sequence?: unknown };
  if (typeof sequence !== "number") throw new ServiceError(422,"validation_failed");
  assertSequence(sequence);
  return sequence;
}

export async function startCandidateRecording(service: InterviewService, token: string | null, input: unknown) {
  const store = storage(service);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["type","consent_version"].includes(k))) throw new ServiceError(422,"validation_failed");
  const { type, consent_version } = input as { type?: unknown; consent_version?: unknown };
  if (typeof type !== "string" || type.length > 100) throw new ServiceError(422,"validation_failed");
  if (consent_version !== recordingConsentVersion) throw new ServiceError(422,"recording_consent_required");
  let contentType: RecordingType;
  try { contentType = recordingType(type); } catch { throw new ServiceError(415,"unsupported_recording_type"); }
  return transaction(service.pool,async db => {
    const { row, attempt } = await candidateAttempt(db,token);
    if (row.execution_status !== "in_progress" || attempt.ended_at) throw new ServiceError(409,"recording_closed");
    const recording = await openRecording(db,{ accountId: row.account_id, interviewId: row.id, attemptId: attempt.id },
      store.config.prefix,contentType,consent_version);
    return { status: recording.status, content_type: recording.content_type, max_chunk_bytes: store.config.maxChunkBytes,
      max_sequence: Math.min(maxChunkSequence,row.request.configuration.duration_limit_seconds) };
  });
}

/** Issues a presigned upload for one chunk. Chunks may arrive out of order; each sequence is bounded by the interview length. */
export async function candidateChunkUpload(service: InterviewService, token: string | null, input: unknown) {
  const store = storage(service);
  const sequence = chunkSequence(input);
  const chunk = await transaction(service.pool,async db => {
    const { row, recording } = await candidateRecording(db,token);
    // At most one chunk per second of interview, so a session cannot create unbounded rows.
    if (sequence > row.request.configuration.duration_limit_seconds) throw new ServiceError(422,"validation_failed");
    return { ...await issueChunk(db,recording.id,sequence), content_type: recording.content_type };
  });
  return { sequence, upload: await store.uploadForm(chunk.object_key,chunk.content_type) };
}

/** Confirms a chunk with the size S3 reports; the browser's own claim about the upload is not trusted. */
export async function confirmCandidateChunk(service: InterviewService, token: string | null, input: unknown) {
  const store = storage(service);
  const sequence = chunkSequence(input);
  const { recording, chunk } = await transaction(service.pool,async db => {
    const { recording } = await candidateRecording(db,token);
    const chunk = (await db.query<ChunkRow>("SELECT * FROM service_recording_chunks WHERE recording_id=$1 AND sequence=$2",[recording.id,sequence])).rows[0];
    if (!chunk) throw new ServiceError(404,"chunk_not_issued");
    return { recording, chunk };
  });
  const bytes = await store.size(chunk.object_key);
  if (!bytes) throw new ServiceError(409,"chunk_not_uploaded");
  const confirmed = await transaction(service.pool,db => confirmChunk(db,recording.id,sequence,bytes));
  return { sequence, bytes: Number(confirmed.bytes) };
}
