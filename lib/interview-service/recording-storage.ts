import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectsCommand,
  GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertId } from "./security.ts";

/** Browser recorders produce WebM (Chrome, Firefox, Edge) or MP4 (Safari). Codec parameters are not part of the stored type. */
export const recordingTypes = { "video/webm": "webm", "video/mp4": "mp4" } as const;
export type RecordingType = keyof typeof recordingTypes;
export const maxChunkSequence = 99_999;

export interface RecordingStorageConfig {
  bucket: string; region: string; prefix: string; endpoint?: string;
  maxChunkBytes: number; uploadTtlSeconds: number; playbackTtlSeconds: number;
}
export interface UploadForm { url: string; fields: Record<string,string>; expires_at: string }

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string) {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}
/**
 * Returns undefined while recording is off. Credentials come from the AWS default chain (AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY, or an instance role) and are never read or logged here.
 */
export function recordingStorageConfig(env: Record<string,string | undefined> = process.env): RecordingStorageConfig | undefined {
  if (env.INTERVIEW_RECORDING_ENABLED !== "true") return undefined;
  const bucket = env.INTERVIEW_RECORDING_S3_BUCKET ?? "";
  const region = env.INTERVIEW_RECORDING_S3_REGION ?? "";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("INTERVIEW_RECORDING_S3_BUCKET must be an S3 bucket name");
  if (!/^[a-z0-9-]+$/.test(region)) throw new Error("INTERVIEW_RECORDING_S3_REGION must be an AWS region such as ap-south-1");
  const prefix = env.INTERVIEW_RECORDING_S3_PREFIX ?? "interviews/";
  if (!/^([a-z0-9][a-z0-9_-]*\/)*$/.test(prefix)) throw new Error("INTERVIEW_RECORDING_S3_PREFIX must be empty or end with / (for example interviews/)");
  let endpoint: string | undefined;
  if (env.INTERVIEW_RECORDING_S3_ENDPOINT) {
    const url = new URL(env.INTERVIEW_RECORDING_S3_ENDPOINT);
    // A custom endpoint is for S3-compatible storage; plain HTTP is allowed only for a local test server.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1"].includes(url.hostname))) {
      throw new Error("INTERVIEW_RECORDING_S3_ENDPOINT must use HTTPS");
    }
    endpoint = url.origin;
  }
  return {
    bucket, region, prefix, endpoint,
    maxChunkBytes: integer(env.INTERVIEW_RECORDING_MAX_CHUNK_BYTES, 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024, "INTERVIEW_RECORDING_MAX_CHUNK_BYTES"),
    uploadTtlSeconds: integer(env.INTERVIEW_RECORDING_UPLOAD_TTL_SECONDS, 300, 60, 3600, "INTERVIEW_RECORDING_UPLOAD_TTL_SECONDS"),
    playbackTtlSeconds: integer(env.INTERVIEW_RECORDING_PLAYBACK_TTL_SECONDS, 900, 60, 43_200, "INTERVIEW_RECORDING_PLAYBACK_TTL_SECONDS"),
  };
}

export function recordingType(value: string): RecordingType {
  const base = value.split(";")[0].trim().toLowerCase();
  if (!(base in recordingTypes)) throw new Error("Unsupported recording type");
  return base as RecordingType;
}
/** All objects for one attempt share this prefix, so deletion can remove them together. */
export function attemptPrefix(prefix: string, accountId: string, interviewId: string, attemptId: string) {
  return `${prefix}${assertId(accountId)}/${assertId(interviewId)}/${assertId(attemptId)}/`;
}
export function chunkKey(attempt: string, sequence: number, type: RecordingType) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > maxChunkSequence) throw new Error("Invalid chunk sequence");
  return `${attempt}chunks/${String(sequence).padStart(5,"0")}.${recordingTypes[type]}`;
}
export function recordingKey(attempt: string, type: RecordingType) {
  return `${attempt}recording.${recordingTypes[type]}`;
}

/** Holds no media: the browser uploads to S3 directly and recruiters play back from S3 through expiring links. */
export class RecordingStorage {
  config: RecordingStorageConfig;
  client: S3Client;
  constructor(config: RecordingStorageConfig, client?: S3Client) {
    this.config = config;
    this.client = client ?? new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: Boolean(config.endpoint) });
  }
  private owned(key: string) {
    if (!key.startsWith(this.config.prefix) || key.includes("..")) throw new Error("Object key is outside the recording prefix");
    return key;
  }
  /** S3 itself rejects a different key, a different type or a body larger than the configured chunk size. */
  async uploadForm(key: string, type: RecordingType): Promise<UploadForm> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.config.bucket, Key: this.owned(key), Expires: this.config.uploadTtlSeconds,
      Fields: { "Content-Type": type },
      Conditions: [["content-length-range", 1, this.config.maxChunkBytes], ["eq", "$Content-Type", type]],
    });
    return { url, fields, expires_at: new Date(Date.now() + this.config.uploadTtlSeconds * 1000).toISOString() };
  }
  async playbackUrl(key: string) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.bucket, Key: this.owned(key),
      ResponseContentDisposition: "inline" }), { expiresIn: this.config.playbackTtlSeconds });
  }
  /** Returns the stored size, or null when the object does not exist. */
  async size(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.owned(key) }));
      return head.ContentLength ?? 0;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }
  /**
   * Joins chunk objects, in the given order, into one object with a multipart upload. Browser recorders emit one
   * continuous stream, so byte concatenation yields a playable file. Chunks are far smaller than S3's 5 MiB minimum
   * part size, so they are buffered into larger parts; memory stays near one part. Returns the joined size.
   */
  async join(keys: string[], target: string, type: RecordingType, progress: () => Promise<void> = async () => {}, partBytes = 8 * 1024 * 1024) {
    if (!keys.length) throw new Error("Nothing to join");
    const Bucket = this.config.bucket, Key = this.owned(target);
    const { UploadId } = await this.client.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType: type }));
    const parts: { ETag?: string; PartNumber: number }[] = [];
    let buffered: Uint8Array[] = [], size = 0, total = 0;
    const flush = async () => {
      const PartNumber = parts.length + 1;
      const { ETag } = await this.client.send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body: Buffer.concat(buffered) }));
      parts.push({ ETag, PartNumber });
      buffered = []; size = 0;
      await progress();
    };
    try {
      for (const key of keys) {
        const object = await this.client.send(new GetObjectCommand({ Bucket, Key: this.owned(key) }));
        if (!object.Body) throw new Error("Empty recording chunk");
        const bytes = await object.Body.transformToByteArray();
        buffered.push(bytes); size += bytes.length; total += bytes.length;
        if (size >= partBytes) await flush();
      }
      if (size) await flush();
      await this.client.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts } }));
      return total;
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => {});
      throw error;
    }
  }
  /** Deletes specific objects inside the recording prefix. */
  async deleteKeys(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const Objects = keys.slice(i, i + 1000).map(key => ({ Key: this.owned(key) }));
      const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.config.bucket, Delete: { Objects, Quiet: true } }));
      if (result.Errors?.length) throw new Error("Some recording objects could not be deleted");
    }
  }
  /** Deletes every object under an attempt prefix and returns how many were removed. */
  async deletePrefix(prefix: string) {
    const [account, interview, attempt, rest] = this.owned(prefix).slice(this.config.prefix.length).split("/");
    if (rest !== "" || prefix !== attemptPrefix(this.config.prefix, account, interview, attempt)) throw new Error("Refusing to delete outside one attempt");
    let removed = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap(o => o.Key ? [{ Key: o.Key }] : []);
      if (keys.length) {
        const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.config.bucket, Delete: { Objects: keys, Quiet: true } }));
        if (result.Errors?.length) throw new Error("Some recording objects could not be deleted");
        removed += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }
}

export function recordingStorage(env: Record<string,string | undefined> = process.env) {
  const config = recordingStorageConfig(env);
  return config ? new RecordingStorage(config) : undefined;
}
