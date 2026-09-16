import assert from 'node:assert/strict';
import test from 'node:test';
import { applyObservation, initialObservationState, markCaptureGap } from '../lib/interview-service/provider.ts';
import { normalizeOpenAILiveEvent, openaiLiveStopCommand } from '../lib/interview-service/providers/openai-live-observation.ts';
import { FakeExecutionProvider } from './helpers/fake-execution-provider.ts';

const usage = (id, seconds) => ({ event_id: id, type: 'session.usage.updated', usage: { seconds } });
const closed = (seconds, reason = 'close_requested') => ({
  event_id: 'closed', type: 'session.closed', usage: { seconds }, reason,
});
const fragment = { event_id: 'f1', type: 'session.input_transcript.delta', delta: 'An index speeds up reads.', start_ms: 10, end_ms: 500 };
const normalized = (event) => normalizeOpenAILiveEvent(event);
const collect = async (provider) => {
  let state = initialObservationState();
  for await (const event of provider.observe({ providerReference: 'private-session' })) state = applyObservation(state, event);
  return state;
};

test('fake execution and vendor observations feed the same provider-neutral reducer', async () => {
  const provider = new FakeExecutionProvider([
    { id: 'f1', kind: 'transcript.fragment', speaker: 'candidate', text: fragment.delta, startMs: 10, endMs: 500 },
    { id: 'u1', kind: 'usage.snapshot', cumulativeAudioMs: 10_000 },
    { id: 'closed', kind: 'execution.closed', cumulativeAudioMs: 12_500, outcome: 'completed' },
  ]);
  const expected = await collect(provider);
  let actual = initialObservationState();
  for (const event of [fragment, usage('u1', 10), closed(12.5)]) actual = applyObservation(actual, normalized(event));
  assert.deepEqual(actual, expected);
  assert.equal(actual.cumulativeAudioMs, 12_500);
});

test('cumulative snapshots and duplicate delivery never add duplicate usage or evidence', () => {
  let state = initialObservationState();
  for (const event of [fragment, fragment, usage('u1', 10), usage('u2', 12), usage('u3', 11), usage('u2', 12)]) {
    state = applyObservation(state, normalized(event));
  }
  assert.equal(state.cumulativeAudioMs, 12_000);
  assert.equal(state.fragments.length, 1);
  assert.equal(state.usageStatus, 'provisional');
  const checkpoint = JSON.parse(JSON.stringify(state));
  assert.deepEqual(applyObservation(checkpoint, normalized(fragment)), checkpoint);
  assert.throws(() => applyObservation(state, normalized({ ...fragment, delta: 'altered' })), /Conflicting/);
});

test('connection loss without terminal usage cannot become final or complete', () => {
  let state = applyObservation(initialObservationState(), normalized(usage('u1', 9)));
  state = markCaptureGap(state);
  assert.equal(state.usageStatus, 'provisional');
  assert.equal(state.outcome, null);
  state = applyObservation(state, normalized(closed(10, 'connection_lost')));
  assert.equal(state.usageStatus, 'final');
  assert.equal(state.outcome, 'interrupted');
  assert.equal(state.captureIncomplete, true);
});

test('regressing final usage and post-final observations require reconciliation', () => {
  let state = applyObservation(initialObservationState(), normalized(usage('u1', 10)));
  assert.throws(() => applyObservation(state, normalized(closed(9))), /regressed/);
  state = applyObservation(state, normalized(closed(11)));
  assert.equal(applyObservation(state, normalized(closed(11))), state);
  assert.throws(() => applyObservation(state, normalized(usage('u2', 12))), /finalization/);
});

test('invalid measurements, transcript ranges, and special event IDs are safe', () => {
  for (const seconds of [-1, NaN, Infinity]) assert.throws(() => normalized(usage('bad', seconds)));
  assert.throws(() => applyObservation(initialObservationState(), normalized({ ...fragment, end_ms: -1 })));
  const event = normalized(usage('__proto__', 2));
  const state = applyObservation(initialObservationState(), event);
  assert.equal(applyObservation(state, event), state);
});

test('stop requests target the live session and irrelevant events are ignored', async () => {
  assert.deepEqual(openaiLiveStopCommand('stop_1'), { type: 'session.close', event_id: 'stop_1' });
  assert.equal(normalized({ type: 'info' }), null);
  const fake = new FakeExecutionProvider([normalized(usage('u1', 1))]);
  await fake.requestStop({ providerReference: 'private-session' });
  assert.equal((await collect(fake)).usageStatus, 'pending');
});
