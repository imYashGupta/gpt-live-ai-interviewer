import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTranscript } from "../lib/interview-service/live-provider.ts";
import { liveSessionConfiguration } from "../lib/interview-service/providers/openai-live.ts";
import { validateAssessment } from "../lib/interview-service/live-worker.ts";
import { billableSeconds } from "../lib/interview-service/service.ts";

test("live session policy prevents browser instruction, transcript and history injection", () => {
  const config = liveSessionConfiguration({
    candidate: { display_name: "Example" },
    job: { title: "Engineer" },
    configuration: {
      duration_limit_seconds: 60,
      difficulty: "mid",
      follow_ups_enabled: false,
    },
  });
  assert.deepEqual(config.client.data_channel, {
    allowed_client_events: [],
    allowed_server_events: [],
  });
  assert.equal(config.store, false);
  assert.equal(config.model, "gpt-live-1");
  assert.match(config.instructions, /untrusted data/);
});
test("server fragments produce stable evidence turns without merging different speakers", () => {
  const fragment = (id, speaker, text, startMs, endMs) => ({
    id,
    kind: "transcript.fragment",
    speaker,
    text,
    startMs,
    endMs,
  });
  const events = [
    fragment("a", "interviewer", "Explain indexes.", 0, 100),
    fragment("b", "candidate", "An index ", 200, 300),
    fragment("c", "candidate", "speeds up reads.", 301, 400),
    fragment("d", "interviewer", "What are the tradeoffs?", 500, 800),
  ];
  const turns = normalizeTranscript(events);
  assert.equal(turns.length, 3);
  assert.equal(turns[1].id, "turn_2");
  assert.equal(turns[1].text, "An index speeds up reads.");
  assert.deepEqual(normalizeTranscript(events), turns);
});
test("assessments reject fabricated evidence, absent evidence, duplicate metrics and invalid scores", () => {
  const good = {
    summary: "Limited evidence",
    competencies: [
      {
        id: "knowledge",
        score: 70,
        rationale: "Supported answer",
        evidence_ids: ["turn_2"],
      },
    ],
  };
  const ids = new Set(["turn_2"]);
  validateAssessment(good, ids);
  for (const patch of [
    { score: 101 },
    { score: NaN },
    { evidence_ids: [] },
    { evidence_ids: ["interviewer_1"] },
    { evidence_ids: ["turn_2", "turn_2"] },
    { id: "personality" },
  ]) {
    assert.throws(() =>
      validateAssessment(
        { ...good, competencies: [{ ...good.competencies[0], ...patch }] },
        ids
      )
    );
  }
  assert.throws(() =>
    validateAssessment(
      { ...good, competencies: [...good.competencies, ...good.competencies] },
      ids
    )
  );
  validateAssessment(
    {
      ...good,
      competencies: [
        { ...good.competencies[0], score: null, evidence_ids: [] },
      ],
    },
    ids
  );
});

test("billable seconds charge exact used time and nothing for service failures", () => {
  const row = { execution_provider: "openai_live", deletion_requested_at: null, request: { configuration: { duration_limit_seconds: 300 } } };
  assert.equal(billableSeconds(row, "completed", 7, true), 7);
  assert.equal(billableSeconds(row, "cancelled", 125, true), 125);
  assert.equal(billableSeconds(row, "completed", 304, true), 300);
  assert.equal(billableSeconds(row, "interrupted", 120, true), 0);
  assert.equal(billableSeconds(row, "failed", 120, true), 0);
  assert.equal(billableSeconds(row, "completed", 120, false), 0);
  assert.equal(billableSeconds({ ...row, execution_provider: "fake" }, "completed", 120, true), 0);
  assert.equal(billableSeconds({ ...row, deletion_requested_at: new Date(), request: null }, "completed", 120, true), 0);
});
