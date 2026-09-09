import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import { createStreamLogCollector, LOG_RESULT_MAX_CHARS } from "../server/log-content.js";
import { streamRawResponse, streamConvertedResponse } from "../server/convert/stream.js";

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
function output() {
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, chunks: [] as string[], write(chunk: string | Uint8Array) { this.chunks.push(String(chunk)); return true; } });
  return { response: response as unknown as http.ServerResponse, text: () => response.chunks.join("") };
}

test("captures late reply deltas beyond the old 1200-character preview, across chunk boundaries", () => {
  const collector = createStreamLogCollector();
  const text = frame({ type: "response.created", response: { metadata: "x".repeat(2500) } }) + frame({ type: "response.output_text.delta", delta: "实际回复" }) + frame({ type: "response.completed", response: { output: [{ content: [{ text: "实际回复" }] }] } });
  for (let index = 0; index < text.length; index += 7) collector.push(text.slice(index, index + 7));
  assert.equal(collector.finish(), "实际回复");
});

test("raw streaming keeps wire content intact and stops after a complete terminal frame", async () => {
  const text = frame({ choices: [{ delta: { content: "hello" } }] }) + "data: [DONE]\n\n";
  let cancelled = false;
  const upstreamBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text.slice(0, -1))); controller.enqueue(new TextEncoder().encode(text.slice(-1))); }, cancel() { cancelled = true; } });
  const sink = output();
  assert.equal(await streamRawResponse({ upstreamBody, response: sink.response, proxyKind: "chat-completions" }), "hello");
  assert.equal(sink.text(), text);
  assert.equal(cancelled, true);
});

test("converted streaming captures original upstream content and preserves converter output", async () => {
  const events = [{ type: "response.output_text.delta", delta: "answer" }, { type: "response.completed", response: { output: [{ content: [{ text: "answer" }] }] } }];
  const upstreamBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(events.map(frame).join(""))); controller.close(); } });
  const sink = output();
  const result = await streamConvertedResponse({ upstreamBody, response: sink.response, proxyKind: "messages", routeEndpoint: "responses", routeModel: "test", requestBody: {}, converter: {
    convertRequest: (body) => body, convertResponse: (body) => body,
    async *convertStream(stream) { for await (const value of stream) { const event = value as { type: string; delta?: string }; yield event.type === "response.completed" ? { type: "message_stop" } : { type: "content_block_delta", delta: { type: "text_delta", text: event.delta } }; } }
  } });
  assert.equal(result, "answer");
  assert.match(sink.text(), /message_stop/);
  assert.match(sink.text(), /answer/);
});

test("tracks errors after long streams and bounds captured response text", async () => {
  const collector = createStreamLogCollector();
  collector.event({ choices: [{ delta: { content: "x".repeat(LOG_RESULT_MAX_CHARS * 2) } }] });
  collector.event({ type: "error", error: { message: "quota exhausted" } });
  assert.match(collector.error, /quota exhausted/);
  assert.equal(collector.finish().length, LOG_RESULT_MAX_CHARS);
  const sink = output();
  const upstreamBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ type: "error", error: { message: "quota exhausted" } }))); controller.close(); } });
  await assert.rejects(streamRawResponse({ upstreamBody, response: sink.response, proxyKind: "responses" }), /quota exhausted/);
});
