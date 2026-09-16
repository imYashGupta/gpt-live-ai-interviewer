import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { signWebhook } from '../lib/interview-service/webhook-signature.ts';
import { validateInterviewSemantics, validateResultEvidence } from '../lib/interview-service/contract-rules.ts';

const root = new URL('../contracts/interview-service/v1/', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const schema = read('schemas.json');
const api = read('openapi.json');
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(schema);
const validate = (name, value) => {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  const valid = check(value);
  return { valid, errors: check.errors };
};
const fixture = (name) => read(`fixtures/${name}.json`);

for (const [file, name] of Object.entries(read('fixtures/manifest.json'))) {
  test(`shared ${file} satisfies ${name}`, () => {
    const { valid, errors } = validate(name, read(`fixtures/${file}`));
    assert.ok(valid, JSON.stringify(errors));
  });
}

test('all OpenAPI schema references compile and mutation commands require idempotency', () => {
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.match(value.$ref, /^\.\/schemas\.json#\/\$defs\//);
      assert.ok(ajv.getSchema(value.$ref.replace('./schemas.json', schema.$id)));
    }
    Object.values(value).forEach(visit);
  };
  visit(api);
  for (const item of Object.values(api.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (['post', 'patch', 'delete'].includes(method)) assert.ok(operation.parameters.some((p) => p.name === 'Idempotency-Key' && p.required));
    }
  }
});

test('rejects vendor configuration, fractional duration, and missing reviewed plans', () => {
  for (const change of [
    (v) => { v.configuration.model = 'vendor-model'; },
    (v) => { v.configuration.duration_limit_seconds = 1.5; },
    (v) => { v.configuration.mode = 'structured'; },
    (v) => { v.configuration.plan_version_id = 'plan_unexpected'; },
    (v) => { v.availability.opens_at = 'not-a-date'; },
    (v) => { v.workspace_id = '../another-workspace'; },
  ]) {
    const value = fixture('create-interview'); change(value);
    assert.equal(validate('CreateInterviewRequest', value).valid, false);
  }
  const structured = fixture('create-interview');
  structured.configuration.mode = 'structured';
  structured.configuration.plan_version_id = 'plan_reviewed_v1';
  assert.equal(validate('CreateInterviewRequest', structured).valid, true);
});

test('enforces duration, authorization, and real timezone semantics', () => {
  validateInterviewSemantics(fixture('create-interview'));
  for (const change of [
    (v) => { v.availability.last_start_at = v.availability.must_finish_at; },
    (v) => { v.authorization_budget.max_quantity = 899; },
    (v) => { v.authorization_budget.start_before = v.availability.opens_at; },
    (v) => { v.availability.display_timezone = 'Made/Up'; },
  ]) {
    const value = fixture('create-interview'); change(value);
    assert.throws(() => validateInterviewSemantics(value));
  }
});

test('preserves unassessed vs zero scores and rejects fabricated evidence', () => {
  validateResultEvidence(fixture('result'));
  const zero = fixture('result'); zero.overall_score = 0; zero.competencies[0].score = 0;
  assert.equal(validate('Result', zero).valid, true);
  const unassessed = fixture('result');
  unassessed.status = 'insufficient_evidence'; unassessed.overall_score = null;
  unassessed.competencies[0].score = null; unassessed.competencies[0].evidence_ids = [];
  assert.equal(validate('Result', unassessed).valid, true);
  unassessed.overall_score = 0;
  assert.equal(validate('Result', unassessed).valid, false);
  for (const evidence of [['invented'], ['turn_1'], ['turn_2', 'turn_2'], []]) {
    const value = fixture('result'); value.competencies[0].evidence_ids = evidence;
    assert.throws(() => validateResultEvidence(value));
  }
});

test('credit quantities are exact decimal strings and external payloads contain no vendor session IDs', () => {
  const value = fixture('usage'); value.data[0].credit_quantity = 12.366667;
  assert.equal(validate('UsagePage', value).valid, false);
  for (const file of Object.keys(read('fixtures/manifest.json'))) {
    assert.doesNotMatch(JSON.stringify(read(`fixtures/${file}`)), /openai|gpt-live|livekit|providerReference|sdp/i);
  }
});

test('webhook signing matches the PHP consumer vector byte for byte', () => {
  const v = fixture('signature-vector');
  const headers = signWebhook(v.body, v.event_id, Number(v.timestamp), v.secret);
  assert.equal(headers['Interview-Signature'], v.signature);
  assert.notEqual(signWebhook(v.body + ' ', v.event_id, Number(v.timestamp), v.secret)['Interview-Signature'], v.signature);
  assert.throws(() => signWebhook(v.body, v.event_id, Number(v.timestamp), 'short'));
});

test('contract snapshot has an explicit version and matching content hashes', () => {
  const lock = read('contract-lock.json');
  assert.equal(lock.version, api.info.version);
  for (const [file, hash] of Object.entries(lock.sha256)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex'), hash, file);
  }
});
