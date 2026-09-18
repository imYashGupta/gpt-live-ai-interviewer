import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { OpenAILiveProvider } from "../lib/interview-service/providers/openai-live.ts";

async function transport(t, onConnection) {
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new OpenAI({
    apiKey: "synthetic-key",
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    maxRetries: 0,
  });
  ws.on("connection", onConnection);
  const observer = new OpenAILiveProvider("synthetic-key", client).attach("private_session");
  t.after(async () => {
    observer.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  await observer.ready;
  return observer;
}
const send = (socket, event) => socket.send(JSON.stringify(event));
const started = { type: "session.started", event_id: "started", session: { id: "private_session" } };
const ack = (type, id) => ({ type, client_event_id: id, event_id: `ack_${id}`, start_ms: 0, end_ms: 0 });
const final = { type: "session.closed", event_id: "closed", reason: "close_requested", usage: { seconds: 1.5 } };

test("SDK sideband greets once after matching acknowledgment, captures evidence and stops remotely", async (t) => {
  const received = [];
  let acceptGreeting;
  const observer = await transport(t, (socket, request) => {
    received.push({ url: request.url, auth: request.headers.authorization });
    send(socket, started);
    send(socket, started); // Repeated startup must not repeat the opening instructions.
    send(socket, { type: "session.input_audio.append", audio: "not-persisted", start_ms: 0, end_ms: 10, event_id: "raw" });
    socket.on("message", (data) => {
      const command = JSON.parse(data.toString());
      received.push(command);
      if (command.type === "session.instructions.append") {
        send(socket, ack("session.instructions.appended", "unrelated-command"));
        // A normal observation provides a barrier before accepting the actual command.
        send(socket, { type: "session.usage.updated", event_id: "barrier", usage: { seconds: 0 } });
      } else if (command.type === "session.commentary.append") {
        send(socket, ack("session.commentary.appended", command.event_id));
        send(socket, { type: "session.output_transcript.delta", delta: "Welcome to your interview.", start_ms: 0, end_ms: 100, event_id: "text" });
      } else if (command.type === "session.close") {
        send(socket, final);
        socket.close();
      }
    });
    // Use a test-only event to deliver the real acknowledgment after the assertions below.
    acceptGreeting = () => {
      const id = received[1].event_id;
      send(socket, ack("session.instructions.appended", id));
      send(socket, ack("session.instructions.appended", id));
    };
  });
  assert.equal((await observer.next(AbortSignal.timeout(5000))).kind, "usage.snapshot");
  assert.equal(received.length, 2, "unmatched acknowledgments cannot begin the interview");
  assert.equal(received[1].type, "session.instructions.append");
  assert.equal(received[1].delegation_id, null);
  assert.match(received[1].content, /English without waiting/);
  assert.match(received[1].content, /Keep all existing interview instructions/);
  acceptGreeting();
  const event = await observer.next(AbortSignal.timeout(5000));
  assert.equal(event.kind, "transcript.fragment");
  assert.equal(event.speaker, "interviewer");
  assert.equal(event.text, "Welcome to your interview.");
  observer.stop();
  const end = await observer.next(AbortSignal.timeout(5000));
  assert.equal(end.kind, "execution.closed");
  assert.equal(end.cumulativeAudioMs, 1500);
  assert.match(received[0].url, /\/v1\/live\/sessions\/private_session\/attach/);
  assert.equal(received[0].auth, "Bearer synthetic-key");
  assert.deepEqual(received.slice(1).map((event) => event.type), [
    "session.instructions.append", "session.commentary.append", "session.close",
  ]);
  assert.equal(received[2].delegation_id, null);
  assert.notEqual(received[1].event_id, received[2].event_id);
});

test("a rejected greeting fails capture instead of leaving a silent live session", async (t) => {
  const received = [];
  const observer = await transport(t, (socket) => {
    send(socket, started);
    socket.on("message", (data) => {
      const command = JSON.parse(data.toString());
      received.push(command);
      send(socket, { type: "error", event_id: "rejected", error: { type: "invalid_request_error", code: "invalid_event", message: "Rejected", client_event_id: command.event_id } });
    });
  });
  await assert.rejects(observer.next(AbortSignal.timeout(5000)), /Live capture interrupted/);
  assert.deepEqual(received.map((event) => event.type), ["session.instructions.append"]);
});

test("missing greeting acknowledgment fails capture within the startup timeout", async (t) => {
  const observer = await transport(t, (socket) => {
    send(socket, started);
    socket.on("message", () => {});
  });
  await assert.rejects(observer.next(AbortSignal.timeout(12000)), /Live capture interrupted/);
});

test("a stop before session.started prevents a late greeting", async (t) => {
  const received = [];
  const observer = await transport(t, (socket) => {
    socket.on("message", (data) => {
      received.push(JSON.parse(data.toString()));
      send(socket, started);
      send(socket, final);
      socket.close();
    });
  });
  observer.stop();
  assert.equal((await observer.next(AbortSignal.timeout(5000))).kind, "execution.closed");
  assert.deepEqual(received.map((event) => event.type), ["session.close"]);
});
