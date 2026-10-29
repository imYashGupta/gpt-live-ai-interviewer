import assert from 'node:assert/strict';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import {
  RecordingStorage, attemptPrefix, chunkKey, recordingKey, recordingStorageConfig, recordingType,
} from '../lib/interview-service/recording-storage.ts';

const env = {
  INTERVIEW_RECORDING_ENABLED: 'true',
  INTERVIEW_RECORDING_S3_BUCKET: 'recooty-interview-recordings',
  INTERVIEW_RECORDING_S3_REGION: 'ap-south-1',
};
// Presigning is computed locally; these fixed credentials never reach the network.
const offlineClient = () => new S3Client({ region: 'ap-south-1', credentials: { accessKeyId: 'AKIAOFFLINETEST', secretAccessKey: 'offline-secret' } });
const attempt = attemptPrefix('interviews/', 'acct_1', 'int_1', 'att_1');

test('recording stays off unless explicitly enabled', () => {
  assert.equal(recordingStorageConfig({}), undefined);
  assert.equal(recordingStorageConfig({ ...env, INTERVIEW_RECORDING_ENABLED: 'false' }), undefined);
});

test('recording config applies defaults and rejects unsafe values', () => {
  assert.deepEqual(recordingStorageConfig(env), {
    bucket: env.INTERVIEW_RECORDING_S3_BUCKET, region: 'ap-south-1', prefix: 'interviews/', endpoint: undefined,
    maxChunkBytes: 8 * 1024 * 1024, uploadTtlSeconds: 300, playbackTtlSeconds: 900,
  });
  assert.throws(() => recordingStorageConfig({ ...env, INTERVIEW_RECORDING_S3_BUCKET: '' }), /BUCKET/);
  assert.throws(() => recordingStorageConfig({ ...env, INTERVIEW_RECORDING_S3_REGION: 'Mumbai!' }), /REGION/);
  assert.throws(() => recordingStorageConfig({ ...env, INTERVIEW_RECORDING_S3_PREFIX: 'no-slash' }), /PREFIX/);
  assert.throws(() => recordingStorageConfig({ ...env, INTERVIEW_RECORDING_S3_PREFIX: '../x/' }), /PREFIX/);
  assert.throws(() => recordingStorageConfig({ ...env, INTERVIEW_RECORDING_S3_ENDPOINT: 'http://storage.example.com' }), /HTTPS/);
  assert.throws(() => recordingStorageConfig({ ...env, INTERVIEW_RECORDING_MAX_CHUNK_BYTES: '10' }), /MAX_CHUNK_BYTES/);
  assert.equal(recordingStorageConfig({ ...env, INTERVIEW_RECORDING_S3_ENDPOINT: 'http://localhost:9000/' }).endpoint, 'http://localhost:9000');
  assert.equal(recordingStorageConfig({ ...env, INTERVIEW_RECORDING_S3_PREFIX: '' }).prefix, '');
});

test('object keys are scoped to one attempt and reject unsafe identifiers', () => {
  assert.equal(attempt, 'interviews/acct_1/int_1/att_1/');
  assert.equal(chunkKey(attempt, 7, 'video/webm'), 'interviews/acct_1/int_1/att_1/chunks/00007.webm');
  assert.equal(recordingKey(attempt, 'video/mp4'), 'interviews/acct_1/int_1/att_1/recording.mp4');
  assert.throws(() => attemptPrefix('interviews/', '../acct', 'int_1', 'att_1'));
  assert.throws(() => chunkKey(attempt, -1, 'video/webm'));
  assert.throws(() => chunkKey(attempt, 100_000, 'video/webm'));
  assert.equal(recordingType('video/webm;codecs=vp8,opus'), 'video/webm');
  assert.equal(recordingType('VIDEO/MP4'), 'video/mp4');
  assert.throws(() => recordingType('text/html'));
});

test('upload form pins the key, type and maximum size', async () => {
  const storage = new RecordingStorage(recordingStorageConfig(env), offlineClient());
  const key = chunkKey(attempt, 0, 'video/webm');
  const form = await storage.uploadForm(key, 'video/webm');
  assert.equal(new URL(form.url).hostname, 'recooty-interview-recordings.s3.ap-south-1.amazonaws.com');
  assert.equal(form.fields.key, key);
  assert.equal(form.fields['Content-Type'], 'video/webm');
  const policy = JSON.parse(Buffer.from(form.fields.Policy, 'base64').toString());
  assert.deepEqual(policy.conditions.find(c => Array.isArray(c) && c[0] === 'content-length-range'), ['content-length-range', 1, 8 * 1024 * 1024]);
  assert.ok(policy.conditions.some(c => c.key === key));
  assert.ok(policy.conditions.some(c => Array.isArray(c) && c[0] === 'eq' && c[1] === '$Content-Type' && c[2] === 'video/webm'));
  const ttl = Date.parse(policy.expiration) - Date.now();
  assert.ok(ttl > 290_000 && ttl <= 300_000);
  await assert.rejects(storage.uploadForm('other/acct_1/x.webm', 'video/webm'), /outside the recording prefix/);
});

test('playback links expire and stay inside the prefix', async () => {
  const storage = new RecordingStorage(recordingStorageConfig(env), offlineClient());
  const url = new URL(await storage.playbackUrl(recordingKey(attempt, 'video/webm')));
  assert.equal(url.pathname, '/interviews/acct_1/int_1/att_1/recording.webm');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  await assert.rejects(storage.playbackUrl('secrets/file'), /outside the recording prefix/);
});

test('size reports missing objects as null and deletion removes only one attempt', async () => {
  const sent = [];
  const objects = ['chunks/00000.webm', 'chunks/00001.webm', 'recording.webm'].map(k => attempt + k);
  const client = { send: async command => {
    const name = command.constructor.name;
    sent.push({ name, input: command.input });
    if (name === 'HeadObjectCommand') {
      if (command.input.Key.endsWith('00009.webm')) throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } });
      return { ContentLength: 1234 };
    }
    if (name === 'ListObjectsV2Command') {
      return command.input.ContinuationToken
        ? { Contents: [{ Key: objects[2] }], IsTruncated: false }
        : { Contents: objects.slice(0, 2).map(Key => ({ Key })), IsTruncated: true, NextContinuationToken: 'page2' };
    }
    if (name === 'DeleteObjectsCommand') return {};
    throw new Error(`unexpected ${name}`);
  } };
  const storage = new RecordingStorage(recordingStorageConfig(env), client);
  assert.equal(await storage.size(chunkKey(attempt, 0, 'video/webm')), 1234);
  assert.equal(await storage.size(chunkKey(attempt, 9, 'video/webm')), null);
  assert.equal(await storage.deletePrefix(attempt), 3);
  const deleted = sent.filter(s => s.name === 'DeleteObjectsCommand').flatMap(s => s.input.Delete.Objects.map(o => o.Key));
  assert.deepEqual(deleted, objects);
  for (const unsafe of ['interviews/', 'interviews/acct_1/', 'interviews/acct_1/int_1/', 'interviews/acct_1/int_1/att_1/chunks/', 'other/a/b/c/']) {
    await assert.rejects(storage.deletePrefix(unsafe), `deletePrefix(${unsafe}) must be refused`);
  }
});

test('failed deletions are reported instead of being counted', async () => {
  const client = { send: async command => command.constructor.name === 'ListObjectsV2Command'
    ? { Contents: [{ Key: attempt + 'recording.webm' }], IsTruncated: false }
    : { Errors: [{ Key: attempt + 'recording.webm', Code: 'AccessDenied' }] } };
  const storage = new RecordingStorage(recordingStorageConfig(env), client);
  await assert.rejects(storage.deletePrefix(attempt), /could not be deleted/);
});
