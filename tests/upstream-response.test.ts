import assert from "node:assert/strict";
import test from "node:test";
import { prepareUpstreamResponse } from "../server/upstream-response.js";

const encoder = new TextEncoder();
const sseHeaders = { "content-type": "text/event-stream" };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const codexMetadata = frame({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 25 } } })
  + frame({ type: "codex.response.metadata", headers: { "x-request-id": "fixture-request" } });

test("stream preparation preserves prelude frames and UTF-8 bytes across arbitrary chunk boundaries", async () => {
  const text = ': keepalive\r\n\r\n' + codexMetadata + frame({ type: "response.created", response: { output: [] } })
    + frame({ type: "response.output_text.delta", delta: "你好 🌍" })
    + frame({ type: "response.completed", response: { output: [] } });
  const bytes = encoder.encode(text);
  let offset = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 1)); offset++;
    }
  }), { headers: sseHeaders });
  const prepared = await prepareUpstreamResponse(response, true);
  assert.equal(await prepared.text(), text);
});

test("early named errors, nested Responses errors and string errors cancel the upstream", async (t) => {
  for (const text of [
    'event: error\ndata: {"message":"busy"}\n\n',
    'event: error\ndata: busy\n\n',
    frame({ type: "response.failed", response: { error: { message: "busy" } } }),
    frame({ error: "busy" })
  ]) await t.test(text.trim().slice(0, 60), async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(text)); },
      cancel() { cancelled = true; }
    }), { headers: sseHeaders });
    await assert.rejects(prepareUpstreamResponse(response, true), /busy/);
    assert.equal(cancelled, true);
  });
});

test("Codex metadata keeps overloads inside the retry boundary with or without Content-Type", async (t) => {
  for (const headers of [sseHeaders, {}]) await t.test("content-type" in headers ? "SSE header" : "headerless SSE", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of [codexMetadata, frame({ type: "response.created", response: { output: [] } }), frame({ type: "error", code: "server_is_overloaded", message: "servers overloaded" })]) {
          controller.enqueue(encoder.encode(text));
        }
      },
      cancel() { cancelled = true; }
    }), { headers });
    await assert.rejects(prepareUpstreamResponse(response, true), /servers overloaded/);
    assert.equal(cancelled, true);
  });
  await assert.rejects(prepareUpstreamResponse(new Response(codexMetadata, { headers: sseHeaders }), true), /返回内容前结束/);
});

test("SSE heartbeats never commit a response before a subsequent overload", async (t) => {
  for (const heartbeat of [
    frame({ type: "keepalive" }),
    'event: keepalive\r\ndata: {}\r\n\r\n',
    'event: keepalive\ndata: null\n\n',
    'event: keepalive\ndata: keepalive\n\n',
    'event: ping\ndata: pong\n\n',
    frame({ type: "heartbeat", timestamp: 1788861313 }),
    frame({ type: "keep-alive" }),
    frame({ type: "keep_alive" })
  ]) await t.test(heartbeat.trim(), async () => {
    let cancelled = false;
    const startedWith: string[] = [];
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of [codexMetadata, frame({ type: "response.created", response: { output: [] } }), heartbeat,
          frame({ type: "error", error: { code: "server_is_overloaded", message: "heartbeat then overload" } })]) {
          controller.enqueue(encoder.encode(text));
        }
      },
      cancel() { cancelled = true; }
    }));
    await assert.rejects(prepareUpstreamResponse(response, true, undefined, (event) => { startedWith.push(event); }), /heartbeat then overload/);
    assert.equal(cancelled, true);
    assert.deepEqual(startedWith, []);
  });
});

test("buffered heartbeats are replayed unchanged on real output, and heartbeat-only EOF fails", async () => {
  const heartbeat = 'event: keepalive\ndata: keepalive\n\n' + frame({ type: "keepalive" });
  await assert.rejects(prepareUpstreamResponse(new Response(heartbeat), true), /返回内容前结束/);
  const text = heartbeat + frame({ type: "response.output_text.delta", delta: "still streaming" });
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(text)); },
    cancel() { cancelled = true; }
  }));
  const startedWith: string[] = [];
  const prepared = await prepareUpstreamResponse(response, true, undefined, (event) => { startedWith.push(event); });
  assert.deepEqual(startedWith, ["response.output_text.delta"]);
  const reader = prepared.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), text);
  await reader.cancel();
  assert.equal(cancelled, true);
  await assert.rejects(prepareUpstreamResponse(new Response('event: keepalive\ndata: {"error":{"message":"busy"}}\n\n'), true), /busy/);
});

test("waiting after a heartbeat remains cancellable without committing a response", { timeout: 1000 }, async () => {
  const abort = new AbortController();
  let cancelled = false;
  const startedWith: string[] = [];
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame({ type: "keepalive" }))); },
    cancel() { cancelled = true; }
  }));
  const pending = prepareUpstreamResponse(response, true, abort.signal, (event) => { startedWith.push(event); });
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.deepEqual(startedWith, []);
});

test("empty Responses output items cannot commit a stream when Lite omits or nulls content fields", async (t) => {
  for (const item of [
    { type: "reasoning", id: "rs_fixture" },
    { type: "reasoning", id: "rs_fixture", summary: null, content: null },
    { type: "reasoning", summary: [], encrypted_content: "opaque context, not a reply" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "" }] },
    { type: "message", id: "msg_fixture", role: "assistant" },
    { type: "message", content: null },
    { type: "message", content: [{ type: "output_text", text: "" }] }
  ]) for (const type of ["response.output_item.added", "response.output_item.done", "response.in_progress"]) {
    await t.test(`${type}: ${JSON.stringify(item)}`, async () => {
      const event = type === "response.in_progress" ? { type, response: { output: [item] } } : { type, item };
      const text = frame({ type: "response.created", response: { output: [] } }) + frame(event)
        + frame({ type: "error", error: { code: "server_is_overloaded", message: "empty item then overloaded" } });
      const startedWith: string[] = [];
      await assert.rejects(prepareUpstreamResponse(new Response(text), true, undefined, (event) => { startedWith.push(event); }), /empty item then overloaded/);
      assert.deepEqual(startedWith, []);
    });
  }
});

test("empty content lifecycle events stay inside preparation until actual output", async (t) => {
  for (const event of [
    { type: "response.content_part.added", part: null },
    { type: "response.content_part.done", part: { type: "output_text", text: "" } },
    { type: "response.reasoning_summary_part.added" },
    { type: "response.reasoning_summary_part.done", part: { type: "summary_text", text: "" } },
    { type: "response.output_text.delta", delta: "" },
    { type: "response.output_text.done", text: "" },
    { type: "response.reasoning_summary_text.delta", delta: "" },
    { type: "response.reasoning_summary_text.done", text: "" },
    { type: "response.reasoning_text.delta", delta: "" },
    { type: "response.reasoning_text.done", text: "" },
    { type: "response.refusal.delta", delta: "" },
    { type: "response.refusal.done", refusal: "" }
  ]) await t.test(event.type, async () => {
    await assert.rejects(prepareUpstreamResponse(new Response(frame(event) + frame({ type: "error", message: "empty event then overload" })), true), /empty event then overload/);
  });
});

test("nonempty output items and content events still stream immediately and preserve their bytes", { timeout: 1000 }, async (t) => {
  for (const event of [
    { type: "response.output_item.added", item: { type: "reasoning", summary: [{ type: "summary_text", text: "Visible reasoning" }] } },
    { type: "response.output_item.added", item: { type: "reasoning", content: [{ type: "reasoning_text", text: "Visible reasoning" }] } },
    { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "answer" }] } },
    { type: "response.in_progress", response: { output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }] } },
    { type: "response.content_part.added", part: { type: "refusal", refusal: "cannot answer" } },
    { type: "response.content_part.done", part: { type: "output_text", text: "answer" } },
    { type: "response.reasoning_summary_text.delta", delta: "Visible reasoning" },
    { type: "response.reasoning_text.done", text: "Visible reasoning" },
    { type: "response.output_text.done", text: "answer" },
    { type: "response.refusal.done", refusal: "cannot answer" },
    { type: "response.output_item.added", item: { type: "image_generation_call", result: "image data" } }
  ]) await t.test(JSON.stringify(event), async () => {
    const text = frame({ type: "response.output_item.added", item: { type: "reasoning" } }) + frame(event);
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(text)); },
      cancel() { cancelled = true; }
    }));
    const startedWith: string[] = [];
    const prepared = await prepareUpstreamResponse(response, true, undefined, (type) => { startedWith.push(type); });
    assert.deepEqual(startedWith, [event.type]);
    const reader = prepared.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), text);
    await reader.cancel();
    assert.equal(cancelled, true);
  });
});

test("tool actions and extension events start forwarding without waiting for EOF", { timeout: 1000 }, async (t) => {
  for (const value of [
    { type: "response.output_item.added", item: { type: "function_call", name: "read_file", arguments: "" } },
    { type: "content_block_start", content_block: { type: "tool_use", name: "read_file", input: {} } },
    { choices: [{ delta: { tool_calls: [{ function: { name: "read_file" } }] } }] },
    { type: "vendor.progress", progress: 1 }
  ]) await t.test(JSON.stringify(value), async () => {
    const text = frame(value);
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text)); } }), { headers: sseHeaders });
    const prepared = await prepareUpstreamResponse(response, true);
    const reader = prepared.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), text);
    await reader.cancel();
  });
});

test("a client abort releases an idle upstream while its prelude is still buffered", { timeout: 1000 }, async () => {
  const abort = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame({ type: "response.created", response: { output: [] } }))); },
    cancel() { cancelled = true; }
  }), { headers: sseHeaders });
  const pending = prepareUpstreamResponse(response, true, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("a prelude-only EOF is a failure, while a terminal empty response is valid", async () => {
  await assert.rejects(prepareUpstreamResponse(new Response(frame({ type: "response.created" }), { headers: sseHeaders }), true), /返回内容前结束/);
  const prepared = await prepareUpstreamResponse(new Response("data: [DONE]\n\n", { headers: sseHeaders }), true);
  assert.equal(await prepared.text(), "data: [DONE]\n\n");
});

test("errors after real output in the same chunk remain on the original stream", async () => {
  const text = frame({ choices: [{ delta: { content: "partial" } }] }) + frame({ error: { message: "failed later" } });
  const prepared = await prepareUpstreamResponse(new Response(text, { headers: sseHeaders }), true);
  assert.equal(await prepared.text(), text);
});

test("large prelude frames never open the retry boundary before output", async () => {
  const text = frame({ type: "response.created", response: { output: [], instructions: "fixture instruction ".repeat(8000) } })
    + frame({ type: "error", error: { code: "server_is_overloaded", message: "large prelude overloaded" } });
  const bytes = encoder.encode(text);
  let offset = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 16384)); offset = Math.min(bytes.length, offset + 16384);
    }
  }), { headers: sseHeaders });
  await assert.rejects(prepareUpstreamResponse(response, true), /large prelude overloaded/);
});

test("large buffered metadata preserves bytes on success and remains cancellable before output", async () => {
  const prelude = `: ${"keepalive ".repeat(40000)}\r\n\r\n`
    + frame({ type: "response.created", response: { output: [], instructions: "你好 instruction ".repeat(40000) } });
  const text = prelude + frame({ type: "response.output_text.delta", delta: "ready" });
  const prepared = await prepareUpstreamResponse(new Response(text, { headers: sseHeaders }), true);
  assert.equal(await prepared.text(), text);
  let cancelled = false;
  const abort = new AbortController();
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(prelude)); },
    cancel() { cancelled = true; }
  }), { headers: sseHeaders });
  const pending = prepareUpstreamResponse(upstream, true, abort.signal);
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("stream endpoints returning HTTP 200 JSON errors fail before forwarding", async () => {
  await assert.rejects(prepareUpstreamResponse(Response.json({ error: "busy" }), true), /busy/);
});

test("HTTP 200 error bodies and invalid empty or HTML replies fail inside both preparation paths", async (t) => {
  for (const stream of [false, true]) await t.test(`stream=${stream}`, async () => {
    for (const payload of [{ error: { message: "busy" } }, { type: "service_unavailable_error", message: "busy" }, { type: "response", status: "failed", error: { message: "busy" } }]) {
      await assert.rejects(prepareUpstreamResponse(Response.json(payload), stream), /busy/);
    }
    for (const response of [new Response(null), new Response("  "), new Response("<!doctype html><html><body>gateway</body></html>", { headers: { "content-type": "text/html" } })]) {
      await assert.rejects(prepareUpstreamResponse(response, stream), /空响应|HTML/);
    }
    const httpError = new Response("upstream HTTP error", { status: 429 });
    const prepared = await prepareUpstreamResponse(httpError, stream);
    assert.equal(prepared.status, 429, "real HTTP failures keep their status-specific retry budget");
    assert.equal(await prepared.text(), "upstream HTTP error");
  });
  const failedStream = frame({ type: "response.output_text.delta", delta: "not sent yet" })
    + frame({ type: "response.failed", response: { error: { message: "late failure" } } });
  await assert.rejects(prepareUpstreamResponse(new Response(failedStream, { headers: sseHeaders }), false), /late failure/);
});

test("SSE without a correct Content-Type header detects errors even when the first field is split", async (t) => {
  for (const contentType of [undefined, "application/json", "text/plain"]) await t.test(contentType || "missing header", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of ['ev', 'ent: response.created\r\ndata: {"type":"response.created","response":{"output":[]}}\r\n\r\n', 'event: error\r\ndata: {"type":"error","error":{"message":"overloaded"}}\r\n\r\n']) controller.enqueue(encoder.encode(text));
        controller.close();
      }
    }), { headers: contentType ? { "content-type": contentType } : {} });
    await assert.rejects(prepareUpstreamResponse(response, true), /overloaded/);
  });
});

test("headerless SSE starts forwarding useful output without waiting for the upstream to close", { timeout: 1000 }, async () => {
  const text = codexMetadata + frame({ type: "response.created", response: { output: [] } }) + frame({ type: "response.output_text.delta", delta: "still streaming" });
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(text)); },
    cancel() { cancelled = true; }
  }));
  const prepared = await prepareUpstreamResponse(response, true);
  const reader = prepared.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), text);
  await reader.cancel();
  assert.equal(cancelled, true);
});
