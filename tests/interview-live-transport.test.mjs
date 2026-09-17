import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { OpenAILiveProvider } from "../lib/interview-service/providers/openai-live.ts";

test("SDK adapter authenticates sideband, ignores audio blobs, captures evidence and sends remote stop", async () => {
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  const received = [];
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new OpenAI({
    apiKey: "synthetic-key",
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    maxRetries: 0,
  });
  const provider = new OpenAILiveProvider("synthetic-key", client);
  ws.on("connection", (socket, request) => {
    received.push({ url: request.url, auth: request.headers.authorization });
    socket.send(
      JSON.stringify({
        type: "session.input_audio.append",
        audio: "not-persisted",
        start_ms: 0,
        end_ms: 10,
        event_id: "raw",
      })
    );
    socket.send(
      JSON.stringify({
        type: "session.input_transcript.delta",
        delta: "An index speeds up reads.",
        start_ms: 0,
        end_ms: 100,
        event_id: "text",
      })
    );
    socket.on("message", (data) => {
      received.push(JSON.parse(data.toString()));
      socket.send(
        JSON.stringify({
          type: "session.closed",
          event_id: "closed",
          reason: "close_requested",
          usage: { seconds: 1.5 },
        })
      );
      socket.close();
    });
  });
  let observer;
  try {
    observer = provider.attach("private_session");
    await observer.ready;
    const event = await observer.next(AbortSignal.timeout(5000));
    assert.equal(event.kind, "transcript.fragment");
    assert.equal(event.text, "An index speeds up reads.");
    observer.stop();
    const end = await observer.next(AbortSignal.timeout(5000));
    assert.equal(end.kind, "execution.closed");
    assert.equal(end.cumulativeAudioMs, 1500);
    assert.match(
      received[0].url,
      /\/v1\/live\/sessions\/private_session\/attach/
    );
    assert.equal(received[0].auth, "Bearer synthetic-key");
    assert.equal(received[1].type, "session.close");
  } finally {
    observer?.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
