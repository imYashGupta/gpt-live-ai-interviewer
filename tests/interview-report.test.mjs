import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyReportAnalysis, overallReportScore, REPORT_METRICS,
  validateReportAnalysis, validateReportTranscript,
} from "../lib/interview-report.ts";

const transcript = [
  { id: "q1", speaker: "interviewer", text: "How do indexes work?", startMs: 0, endMs: 2_000 },
  { id: "a1", speaker: "candidate", text: "A B-tree index reduces the records scanned, at the cost of storage and slower writes.", startMs: 3_000, endMs: 12_000 },
  { id: "q2", speaker: "interviewer", text: "How would you debug a slow query?", startMs: 13_000, endMs: 16_000 },
  { id: "a2", speaker: "candidate", text: "I would check the query plan and compare estimated rows with actual rows before changing the index.", startMs: 17_000, endMs: 28_000 },
];

function analysis() {
  return {
    summary: "The candidate explains indexing trade-offs and uses query plans to guide diagnosis.",
    metrics: Object.fromEntries(REPORT_METRICS.map(({ id }) => [id, {
      score: 80, rationale: "Explains the index trade-off and a concrete diagnostic approach.", evidenceIds: ["a1", "a2"],
    }])),
    answers: [
      { topic: "Indexes", questionId: "q1", score: 80, rationale: "Identifies read/write trade-offs.", evidenceIds: ["a1"], improvement: "Compare index types with an example." },
      { topic: "Query diagnosis", questionId: "q2", score: 80, rationale: "Starts with the query plan.", evidenceIds: ["a2"], improvement: "Explain how to interpret a row-estimate mismatch." },
    ],
    strengths: [{ text: "Explains indexing costs.", evidenceIds: ["a1"] }],
    improvements: [{ text: "Give a concrete query plan example.", evidenceIds: ["a2"] }],
    nextSteps: ["Practice comparing query plans before and after adding an index."],
  };
}

test("transcripts are normalized and sorted without merging separate answers", () => {
  assert.deepEqual(validateReportTranscript([...transcript].reverse()), transcript);
  assert.deepEqual(validateReportTranscript([]), []);
  assert.deepEqual(validateReportTranscript([{ ...transcript[0], text: "  " }]), []);
});

test("invalid or oversized transcript inputs are rejected", () => {
  for (const value of [null, {}, [transcript[0], transcript[0]],
    [{ ...transcript[0], speaker: "system" }], [{ ...transcript[0], startMs: NaN }],
    [{ ...transcript[0], endMs: -1 }], [{ ...transcript[0], text: "x".repeat(30_001) }],
    Array.from({ length: 6 }, (_, i) => ({ ...transcript[0], id: String(i), text: "x".repeat(30_000) })),
  ]) assert.equal(validateReportTranscript(value), null);
});

test("a report requires real candidate evidence and bounded scores", () => {
  assert.ok(validateReportAnalysis(analysis(), transcript));
  for (const invalid of [101, -1, 3.5, "80", NaN]) {
    const value = analysis(); value.metrics.accuracy.score = invalid;
    assert.equal(validateReportAnalysis(value, transcript), null);
  }
  for (const evidence of [[], ["invented"], ["q1"], ["a1", "a1"]]) {
    const value = analysis(); value.metrics.knowledge.evidenceIds = evidence;
    assert.equal(validateReportAnalysis(value, transcript), null);
  }
});

test("answer groups cannot invent questions, reuse candidate answers, or cite earlier answers", () => {
  for (const update of [
    (value) => { value.answers[0].questionId = "invented"; },
    (value) => { value.answers[1].questionId = "q1"; },
    (value) => { value.answers[1].evidenceIds = ["a1"]; },
    (value) => { value.answers[0].evidenceIds = ["a2"]; },
    (value) => { value.strengths[0].evidenceIds = ["invented"]; },
  ]) {
    const value = analysis(); update(value);
    assert.equal(validateReportAnalysis(value, transcript), null);
  }
});

test("overall score averages the core skills and ignores expressed confidence", () => {
  const value = analysis();
  value.metrics.accuracy.score = 60;
  value.metrics.knowledge.score = 70;
  value.metrics.problemSolving.score = 80;
  value.metrics.communication.score = 90;
  value.metrics.answerConfidence.score = 0;
  assert.equal(overallReportScore(value), 75);
  value.metrics.answerConfidence.score = 100;
  assert.equal(overallReportScore(value), 75);
  value.metrics.answerConfidence.score = null;
  assert.equal(overallReportScore(value), 75);
});

test("limited evidence is unassessed, not zero, and cannot produce an overall score", () => {
  const empty = emptyReportAnalysis();
  assert.ok(validateReportAnalysis(empty, []));
  assert.equal(overallReportScore(empty), null);
  const short = analysis(); short.answers = short.answers.slice(0, 1);
  assert.equal(overallReportScore(short), null);
  const missing = analysis(); missing.metrics.problemSolving.score = null;
  assert.equal(overallReportScore(missing), null);
  const unsupported = analysis(); unsupported.answers = [];
  assert.equal(validateReportAnalysis(unsupported, transcript), null);
});

test("a genuine zero remains an assessed score", () => {
  const value = analysis();
  for (const metric of Object.values(value.metrics)) metric.score = 0;
  for (const answer of value.answers) answer.score = 0;
  assert.ok(validateReportAnalysis(value, transcript));
  assert.equal(overallReportScore(value), 0);
});
