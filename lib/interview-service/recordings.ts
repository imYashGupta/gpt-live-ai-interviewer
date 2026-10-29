import type { PoolClient } from "pg";
import { attemptPrefix, chunkKey, maxChunkSequence, recordingType, type RecordingType } from "./recording-storage.ts";
import { newId, ServiceError } from "./security.ts";

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
