// Run after npm run build. Uses a temporary database and a local OpenAI stub.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { createAccessCookieValue } from "../lib/access-control.ts";
import { REPORT_METRICS } from "../lib/interview-report.ts";

const directory = mkdtempSync(join(tmpdir(), "interview-report-test-"));
const databasePath = join(directory, "interviews.sqlite");
const port = Number(process.env.REPORT_TEST_PORT || 3112);
const base = `http://localhost:${port}`;
const passcode = "local-report-test-only";
const cookie = `interview_access=${createAccessCookieValue(passcode)}`;
let modelCalls = 0;
let failNext = false;
let delayMs = 50;

const transcript = [
  { id: "q1", speaker: "interviewer", text: "How do database indexes improve a query, and what are their trade-offs?", startMs: 0, endMs: 4_000 },
  { id: "a1", speaker: "candidate", text: "A B-tree index helps locate rows without scanning the whole table. It uses extra storage and each insert or update must maintain it. I would select an index based on our common query filters and verify the query plan.", startMs: 5_000, endMs: 28_000 },
  { id: "q2", speaker: "interviewer", text: "How would you investigate an API that becomes slow under load?", startMs: 30_000, endMs: 35_000 },
  { id: "a2", speaker: "candidate", text: "I would start with request traces, separate database time from external API calls, and check p95 latency. I would reproduce the load, inspect query plans and connection pool saturation, then test one change at a time against the baseline.", startMs: 36_000, endMs: 63_000 },
  { id: "q3", speaker: "interviewer", text: "How do you make a background job safe to retry?", startMs: 65_000, endMs: 70_000 },
  { id: "a3", speaker: "candidate", text: "I would track a unique operation key, check whether the work has already completed, and use a transaction for local changes. I am less sure how to coordinate retries when the external payment service has no idempotency support.", startMs: 71_000, endMs: 94_000 },
];

const stub = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  response.setHeader("Content-Type", "application/json");
  if (request.url.includes("live")) {
    response.end(JSON.stringify({ session: { id: `live_test_${randomUUID()}` }, transport: { type: "webrtc", sdp: "mock-answer" } }));
    return;
  }
  modelCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (failNext) {
    failNext = false;
    response.writeHead(503);
    response.end(JSON.stringify({ error: { message: "Synthetic failure", type: "server_error" } }));
    return;
  }
  const entries = JSON.parse(input.input).transcript;
  const candidates = entries.filter((entry) => entry.speaker === "candidate");
  const questions = entries.filter((entry) => entry.speaker === "interviewer");
  const scores = [86, 78, 74, 88, 76];
  const analysis = {
    summary: "The candidate demonstrates a solid foundation in backend engineering, connecting database concepts to practical troubleshooting. Answers are structured and acknowledge uncertainty appropriately. Distributed failure handling would benefit from deeper examples and a clearer recovery strategy.",
    metrics: Object.fromEntries(REPORT_METRICS.map(({ id }, index) => [id, {
      score: scores[index], rationale: "The answers connect a technical principle to a concrete implementation or diagnostic step, while identifying the limits of the proposed approach.", evidenceIds: [candidates[index % candidates.length].id],
    }])),
    answers: questions.map((question, index) => ({
      topic: ["Database indexing", "Production debugging", "Reliable background jobs"][index % 3],
      questionId: question.id, score: [86, 82, 68][index % 3],
      rationale: ["Correctly explains read/write trade-offs and connects index choice to query patterns.", "Uses traces and percentile latency to narrow the bottleneck before proposing a change.", "Recognizes local idempotency and the harder external-service boundary, but leaves recovery unresolved."][index % 3],
      evidenceIds: [candidates[index].id],
      improvement: ["Add an example of composite-index column ordering and explain how selectivity changes the plan.", "Describe the specific metric that would confirm connection-pool saturation and how to test a fix.", "Walk through a timeout after a successful external payment and explain reconciliation before retrying."][index % 3],
    })),
    strengths: [{ text: "Connects indexing decisions to query patterns and write overhead.", evidenceIds: [candidates[0].id] }, { text: "Uses a measured troubleshooting process with traces and a performance baseline.", evidenceIds: [candidates[1]?.id ?? candidates[0].id] }],
    improvements: [{ text: "Develop a recovery strategy for ambiguous external-service outcomes, including reconciliation and safe retries.", evidenceIds: [candidates.at(-1).id] }],
    nextSteps: ["Compare query plans for a composite index with two different column orders.", "Design a payment retry flow that handles a timeout after a successful charge.", "Practice describing one production incident with the evidence, decision, and measured outcome."],
  };
  response.end(JSON.stringify({ id: "resp_report_test", object: "response", status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(analysis), annotations: [] }] }], usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500, total_tokens: 1_500 } }));
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(port)], {
  env: { ...process.env, APP_PASSCODE: passcode, SQLITE_DATABASE_PATH: databasePath, OPENAI_API_KEY: "local-stub-key", OPENAI_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1` },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });
const stop = () => {
  server.kill(); stub.close();
  server.once("exit", () => rmSync(directory, { recursive: true, force: true }));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const post = (path, body, authenticated = true) => fetch(`${base}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
});
const config = { mode: "ai-led", candidateName: "Alex Morgan", role: "Senior Backend Engineer", difficulty: "senior", durationMinutes: 5, voice: "willow", followUpsEnabled: true, candidateNotes: "Private note excluded from report context", jobDescription: "Design reliable backend services, debug performance issues, and explain engineering trade-offs." };
async function createSession() {
  const response = await post("/api/live/session", { sdp: "mock-offer", interview: config });
  assert.equal(response.status, 201, await response.clone().text());
  const data = await response.json();
  return { id: data.interview.id, openaiSessionId: data.session.id, actualSeconds: 100, transcript };
}

try {
  for (let attempt = 0; ; attempt += 1) {
    try { await fetch(`${base}/access`); break; } catch {
      if (attempt > 50) throw new Error(`Server did not start: ${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.equal((await post("/api/interviews/report", {}, false)).status, 401);
  assert.equal((await post("/api/interviews/report", {})).status, 400);
  const session = await createSession();
  assert.equal((await post("/api/interviews/report", { ...session, openaiSessionId: "wrong" })).status, 404);
  const response = await post("/api/interviews/report", session);
  assert.equal(response.status, 201, await response.clone().text());
  const { report } = await response.json();
  assert.equal(report.overallScore, 82);
  assert.equal(report.candidateName, config.candidateName);
  const calls = modelCalls;
  assert.equal((await post("/api/interviews/report", session)).status, 200);
  assert.equal(modelCalls, calls);

  const database = new Database(databasePath);
  const row = database.prepare("SELECT * FROM interviews WHERE id = ?").get(session.id);
  assert.equal(JSON.parse(row.report_context_json).candidateNotes, "");
  assert.ok(Math.abs(row.estimated_cost_usd - (100 / 60 * 0.05 + report.generation.estimatedCostUsd)) < 0.0000001);
  assert.equal((await fetch(`${base}/interviews/${session.id}/report`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/interviews/${session.id}/report`, { redirect: "manual" })).status, 307);
  const empty = await createSession();
  const emptyResult = await post("/api/interviews/report", { ...empty, transcript: [] });
  assert.equal((await emptyResult.json()).report.overallScore, null);
  assert.equal(modelCalls, calls);

  const retry = await createSession();
  failNext = true;
  assert.equal((await post("/api/interviews/report", retry)).status, 502);
  assert.equal((await post("/api/interviews/report", retry)).status, 201);
  const concurrent = await createSession();
  delayMs = 400;
  const duplicateResults = await Promise.all([post("/api/interviews/report", concurrent), post("/api/interviews/report", concurrent)]);
  assert.deepEqual(duplicateResults.map((result) => result.status).sort(), [201, 409]);
  database.close();
  console.log("PASS: authentication, session creation, generation, citations, score, persistence, cost accounting, empty transcript, retry, concurrent generation, saved-page access.");
  console.log(`Browser test URL: ${base}/interviews/${session.id}/report`);
  console.log(`Empty report URL: ${base}/interviews/${empty.id}/report`);
  if (!process.argv.includes("--serve")) stop();
} catch (error) {
  console.error(error, logs); process.exitCode = 1; stop();
}
