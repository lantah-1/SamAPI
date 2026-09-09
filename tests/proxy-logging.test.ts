import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { JsonStore } from "../server/store/index.js";
import { createRouting } from "../server/routing.js";
import { createProxyHandler } from "../server/handlers/proxy.js";
import { CODEX_USER_AGENT } from "../server/providers/constants.js";

class ResponseRecorder extends EventEmitter {
  statusCode = 0;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  headers: Record<string, unknown> = {};
  chunks: string[] = [];
  writeHead(status: number, headers: Record<string, unknown>) { this.statusCode = status; this.headersSent = true; this.headers = { ...this.headers, ...headers }; return this; }
  setHeader(key: string, value: unknown) { this.headers[key] = value; return this; }
  flushHeaders() {}
  write(chunk: string | Uint8Array) { this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); return true; }
  end(chunk?: string | Uint8Array) { if (chunk) this.write(chunk); this.writableEnded = true; this.emit("finish"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  text() { return this.chunks.join(""); }
}

function setup(t: TestContext, multipleAddresses = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-proxy-log-test-"));
  const store = new JsonStore(dir);
  const sql = new Database(store.sqlitePath);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const site = store.upsertSite({ name: "fixture", addresses: [
    { id: "a", label: "primary", baseUrl: "https://first.invalid/v1", enabled: true, models: [] },
    ...(multipleAddresses ? [{ id: "b", label: "secondary", baseUrl: "https://second.invalid/v1", enabled: true, models: [] }] : [])
  ] });
  store.upsertProviderApiKeyGroup({ siteId: site.id, apiKeys: [{ label: "fixture", secret: "fixture-upstream-key", enabled: true, models: ["fixture-model"] }] });
  store.upsertRoute({ type: "switch", name: "alias", siteId: site.id, model: "fixture-model", endpoint: "chat/completions", enabled: true });
  const key = store.createApiKey("fixture-client");
  const routing = createRouting(store);
  const handler = createProxyHandler({ store, ...routing });
  const request = async (body: unknown, onResponse?: (response: ResponseRecorder) => void, extraHeaders: Record<string, string> = {}, pathname = "/proxy/v1/chat/completions") => {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), {
      headers: { authorization: `Bearer ${key.plainTextKey}`, "content-type": "application/json", "user-agent": "fixture-client", "upstream-custom": "keep-me", ...extraHeaders },
      method: "POST", url: pathname, socket: { remoteAddress: "127.0.0.1" }
    }) as unknown as http.IncomingMessage;
    const res = new ResponseRecorder();
    onResponse?.(res);
    await handler.handleProxy(req, res as unknown as http.ServerResponse, new URL(`http://localhost${pathname}`));
    return res;
  };
  return { store, sql, request };
}

function mockRetryTimers(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
}

async function finishWithRetryTimers<T>(t: TestContext, pending: Promise<T>, maxTicks = 40) {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (let tick = 0; tick < maxTicks && !settled; tick++) {
    await nextTick();
    t.mock.timers.tick(3000);
  }
  assert.equal(settled, true, "request must finish within its configured retry budget");
  return pending;
}

test("proxy end-to-end records shared user turns and original upstream answer without changing forwarding", async (t) => {
  const { store, sql, request } = setup(t);
  let calls = 0;
  globalThis.fetch = async (target, init) => {
    calls++;
    assert.match(String(target), /^https:\/\/first\.invalid\//);
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, "fixture-model");
    assert.deepEqual(payload.tools, [{ type: "function", function: { name: "fixture", parameters: {} } }]);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "真实回复" } }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }), { headers: { "content-type": "application/json" } });
  };
  const body = { model: "alias", messages: [{ role: "user", content: "first" }, { role: "assistant", content: "history" }, { role: "user", content: "second" }], tools: [{ type: "function", function: { name: "fixture", parameters: {} } }] };
  for (let i = 0; i < 2; i++) {
    const res = await request(body);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.text()).choices[0].message.content, "真实回复");
  }
  assert.equal(calls, 2);
  const usage = store.usageReport();
  assert.equal(usage.totals.requests, 2);
  assert.equal(usage.totals.totalTokens, 34);
  assert.equal(usage.clients[0].apiKeyName, "fixture-client");
  assert.equal(store.requestLogCount(), 2);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_messages").get() as { n: number }).n, 1);
  for (const summary of store.listRequestLogs()) {
    const log = store.getRequestLog(summary.id)!;
    assert.deepEqual(log.msg, ["second"]);
    assert.equal(log.result.body, "真实回复");
    assert.equal(log.result.status, "success");
    assert.equal(log.requestHeaders.authorization, "***");
    assert.equal(log.requestHeaders["upstream-custom"], "keep-me");
    assert.equal(log.requestHeaders["upstream-authorization"], undefined);
  }
});

test("streamed JSON-looking reply text is not parsed again or replaced by raw SSE frames", async (t) => {
  const { store, request } = setup(t);
  const answer = '{"choices":[{"message":{"content":"keep original JSON"}}]}\ndata: example';
  const text = `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
  globalThis.fetch = async () => new Response(text, { headers: { "content-type": "text/event-stream" } });
  const res = await request({ model: "alias", stream: true, messages: [{ role: "user", content: "show a JSON example" }] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.text(), text);
  assert.equal(store.getRequestLog(store.listRequestLogs()[0].id)?.result.body, answer);
});

test("stream terminal usage is attributed to the downstream key before releasing an idle upstream", async (t) => {
  const { store, request } = setup(t);
  let cancelled = false;
  globalThis.fetch = async (_target, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream_options.include_usage, true);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":20}}}\n\ndata: [DONE]\n\n')); },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } });
  };
  await request({ model: "alias", stream: true, messages: [{ role: "user", content: "stream me" }] });
  const totals = store.usageReport().totals;
  assert.equal(totals.requests, 1);
  assert.equal(totals.totalTokens, 110);
  assert.equal(totals.cachedInputTokens, 20);
  assert.equal(totals.missingUsageRequests, 0);
  assert.equal(cancelled, true);
});

test("upstream failover logs each attempt while sharing the same message row", async (t) => {
  const { store, sql, request } = setup(t, true);
  globalThis.fetch = async (target) => String(target).includes("first.invalid")
    ? new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503, headers: { "content-type": "application/json" } })
    : new Response(JSON.stringify({ choices: [{ message: { content: "fallback answer" } }] }), { headers: { "content-type": "application/json" } });
  const res = await request({ model: "alias", messages: [{ role: "user", content: "shared across retries" }] });
  assert.equal(res.statusCode, 200);
  const logs = store.listRequestLogs().map((summary) => store.getRequestLog(summary.id)!);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].calls.length, 1);
  assert.equal(logs[0].calls[0].attempts.length, 2);
  assert.ok(logs[0].calls[0].attempts.some((attempt) => attempt.result.status === "failed" && attempt.upstream?.url.includes("first.invalid")));
  assert.ok(logs[0].calls[0].attempts.some((attempt) => attempt.result.status === "success" && attempt.upstream?.url.includes("second.invalid")));
  for (const log of logs) assert.deepEqual(log.msg, ["shared across retries"]);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_messages").get() as { n: number }).n, 1);
  assert.equal(store.usageReport().totals.requests, 2);
  assert.equal(store.usageReport().totals.downstreamRequests, 1);
});

test("client disconnection during an idle stream releases upstream and records cancellation", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t);
  let upstreamCancelled = false;
  globalThis.fetch = async (_target, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      init?.signal?.addEventListener("abort", () => { upstreamCancelled = true; controller.error(new DOMException("Aborted", "AbortError")); }, { once: true });
    }
  }), { headers: { "content-type": "text/event-stream" } });
  await request({ model: "alias", stream: true, messages: [{ role: "user", content: "cancel me" }] }, (response) => { setTimeout(() => response.destroy(), 10); });
  assert.equal(upstreamCancelled, true);
  assert.equal(store.listRequestLogs()[0].result.status, "cancelled");
  assert.equal(store.listRequestLogs()[0].result.statusCode, 499);
});

test("configured HTTP retries bill each actual response once under the original downstream request", { timeout: 10000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 503, count: 1 }] });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(calls === 1 ? { error: { message: "retry" }, usage: { prompt_tokens: 10, completion_tokens: 0 } } : { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }, { status: calls === 1 ? 503 : 200 });
  };
  const res = await request({ model: "alias", messages: [{ role: "user", content: "retry once" }] });
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(store.requestLogCount(), 1);
  assert.equal(store.getRequestLog(store.listRequestLogs()[0].id)?.calls[0].attempts.length, 2);
  const totals = store.usageReport().totals;
  assert.equal(totals.requests, 2); assert.equal(totals.downstreamRequests, 1); assert.equal(totals.totalTokens, 22); assert.equal(totals.missingUsageRequests, 0);
});

test("599 retries transport failures the configured number of times without inventing usage", { timeout: 10000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 2 }] });
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls <= 2) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) });
    return Response.json({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  };
  const result = await request({ model: "alias", messages: [{ role: "user", content: "retry transport" }] });
  assert.equal(result.statusCode, 200);
  assert.equal(calls, 3);
  assert.match(result.text(), /recovered/);
  const attempts = store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts;
  assert.deepEqual(attempts.map((attempt) => attempt.result.statusCode), [599, 599, 200]);
  assert.match(attempts[0].result.body, /fetch failed/);
  const totals = store.usageReport().totals;
  assert.equal(totals.requests, 1); assert.equal(totals.downstreamRequests, 1); assert.equal(totals.totalTokens, 12);
});

test("configured upstream 4xx and 5xx retries keep the request, payload and log together", async (t) => {
  const fixtures = [400, 401, 403, 408, 429, 499, 500, 502, 503, 504, 520, 524, 599].map((status) => ({ status, retries: 2 as number | undefined }));
  fixtures.push({ status: 503, retries: 0 }, { status: 503, retries: undefined });
  for (const { status, retries } of fixtures) await t.test(`${status}: ${retries ?? "unconfigured"}`, { timeout: 2000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: retries === undefined ? [] : [{ statusCode: status, count: retries }] });
    const payloads: string[] = [];
    const requestIds: (string | null)[] = [];
    globalThis.fetch = async (_target, init) => {
      payloads.push(String(init?.body));
      requestIds.push(new Headers(init?.headers).get("x-client-request-id"));
      return payloads.length <= 2
        ? Response.json({ error: { message: "configured HTTP failure" } }, { status })
        : Response.json({ choices: [{ message: { content: "recovered" } }] });
    };
    const result = await finishWithRetryTimers(t, request({ model: "alias", messages: [{ role: "user", content: "keep this request" }] }, undefined, { "x-client-request-id": "fixture-client-request" }));
    const expectedAttempts = (retries || 0) + 1;
    assert.equal(payloads.length, expectedAttempts);
    assert.equal(new Set(payloads).size, 1);
    assert.equal(new Set(requestIds).size, 1);
    assert.equal(result.statusCode, retries ? 200 : status);
    assert.equal(store.requestLogCount(), 1);
    const summary = store.listRequestLogs()[0];
    assert.equal(summary.requestCount, 1);
    assert.equal(summary.attemptCount, expectedAttempts);
    const log = store.getRequestLog(summary.id)!;
    assert.equal(log.calls.length, 1);
    assert.deepEqual(log.calls[0].attempts.map((attempt) => attempt.result.statusCode), retries ? [status, status, 200] : [status]);
  });
});

test("upstream AbortError and HTTP 200 error payloads retry as 599 without cancelling the client", async (t) => {
  for (const kind of ["abort", "JSON error", "HTML", "empty"]) await t.test(kind, { timeout: 2000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 1 }] });
    let calls = 0;
    let downstream!: ResponseRecorder;
    globalThis.fetch = async () => {
      assert.equal(downstream.headersSent, false);
      if (++calls > 1) return Response.json({ choices: [{ message: { content: "recovered" } }] });
      if (kind === "abort") throw new DOMException("This operation was aborted", "AbortError");
      if (kind === "JSON error") return Response.json({ error: { message: "failed despite HTTP 200" } });
      if (kind === "HTML") return new Response("<html><body>gateway failure</body></html>", { headers: { "content-type": "text/html" } });
      return new Response(null);
    };
    const result = await finishWithRetryTimers(t, request({ model: "alias", messages: [{ role: "user", content: "retry the upstream failure" }] }, (response) => { downstream = response; }));
    assert.equal(calls, 2);
    assert.equal(result.statusCode, 200);
    assert.match(result.text(), /recovered/);
    assert.equal(store.requestLogCount(), 1);
    assert.deepEqual(store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts.map((attempt) => attempt.result.statusCode), [599, 200]);
  });
});

test("a later request retries 599 after earlier output in the same conversation, appending to the original log", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 2 }] });
  let calls = 0;
  let downstream!: ResponseRecorder;
  globalThis.fetch = async () => {
    assert.equal(downstream.headersSent, false, "earlier requests must not commit this request's response");
    const attempt = ++calls;
    const text = attempt === 1 || attempt === 4
      ? `data: ${JSON.stringify({ choices: [{ delta: { content: attempt === 1 ? "earlier reply" : "later reply" } }] })}\n\ndata: [DONE]\n\n`
      : 'event: codex.rate_limits\ndata: {"type":"codex.rate_limits","rate_limits":{}}\n\nevent: error\ndata: {"type":"error","code":"server_is_overloaded","message":"fixture overloaded"}\n\n';
    return new Response(text, { headers: { "content-type": "text/event-stream" } });
  };
  const headers = { "x-samapi-turn-id": "fixture-turn", "x-samapi-session-id": "fixture-session" };
  const body = { model: "alias", stream: true, messages: [{ role: "user", content: "one conversation" }] };
  const first = await finishWithRetryTimers(t, request(body, (response) => { downstream = response; }, headers));
  assert.match(first.text(), /earlier reply/);
  const originalId = store.listRequestLogs()[0].id;
  const later = await finishWithRetryTimers(t, request(body, (response) => { downstream = response; }, headers));
  assert.equal(calls, 4);
  assert.match(later.text(), /later reply/);
  assert.doesNotMatch(later.text(), /overloaded|codex.rate_limits|earlier reply/);
  assert.equal(store.requestLogCount(), 1);
  const summary = store.listRequestLogs()[0];
  assert.equal(summary.id, originalId);
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.attemptCount, 4);
  const log = store.getRequestLog(originalId)!;
  assert.deepEqual(log.calls.map((call) => call.attempts.map((attempt) => attempt.result.statusCode)), [[200], [599, 599, 200]]);
});

test("599 retries an SSE overload before exposing stream metadata or errors downstream", { timeout: 10000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 1 }] });
  let calls = 0;
  let firstCancelled = false;
  let downstream!: ResponseRecorder;
  const success = 'data: {"choices":[{"delta":{"content":"recovered stream"}}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async () => {
    calls++;
    assert.equal(downstream.headersSent, false);
    assert.equal(downstream.text(), "");
    if (calls > 1) return new Response(success, { headers: { "content-type": "text/event-stream" } });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [': keepalive\n\ndata: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n', 'event: error\ndata: {"type":"error","error":{"code":"server_is_overloaded","message":"servers overloaded"}}\n', '\n']) controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel() { firstCancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const result = await request({ model: "alias", stream: true, messages: [{ role: "user", content: "retry stream overload" }] }, (response) => { downstream = response; });
  assert.equal(calls, 2);
  assert.equal(result.statusCode, 200);
  assert.equal(result.text(), success);
  assert.equal(firstCancelled, true);
  const attempts = store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts;
  assert.deepEqual(attempts.map((attempt) => attempt.result.statusCode), [599, 200]);
  assert.match(attempts[0].result.body, /servers overloaded/);
  assert.equal(store.usageReport().totals.requests, 2);
});

test("599 retries a response body interrupted before a non-streaming reply is sent", { timeout: 10000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 1 }] });
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls > 1) return Response.json({ choices: [{ message: { content: "complete reply" } }] });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":[')); },
      pull(controller) { controller.error(new TypeError("terminated")); }
    }), { headers: { "content-type": "application/json" } });
  };
  const result = await request({ model: "alias", messages: [{ role: "user", content: "retry incomplete body" }] });
  assert.equal(result.statusCode, 200);
  assert.equal(calls, 2);
  assert.match(result.text(), /complete reply/);
  assert.deepEqual(store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts.map((attempt) => attempt.result.statusCode), [599, 200]);
  assert.equal(store.usageReport().totals.requests, 2);
});

test("sharedchat-style metadata does not bypass configured 599 retries on Responses API routes", async (t) => {
  for (const recovers of [true, false]) await t.test(recovers ? "recovers on the last retry" : "exhausts the retry budget", { timeout: 2000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 2 }] });
    store.upsertRoute({ ...store.getDb().routes[0], endpoint: "responses" });
    let calls = 0;
    let downstream!: ResponseRecorder;
    let success = "";
    globalThis.fetch = async (target) => {
      assert.equal(String(target), "https://first.invalid/v1/responses");
      assert.equal(downstream.headersSent, false);
      assert.equal(downstream.text(), "");
      calls++;
      const recovered = recovers && calls === 3;
      const frames = [
        { type: "codex.rate_limits", plan_type: `fixture-attempt-${calls}`, rate_limits: { primary: { used_percent: 25 } } },
        { type: "codex.response.metadata", headers: { "x-request-id": `fixture-request-${calls}` } },
        { type: "response.created", response: { status: "in_progress", output: [] } },
        { type: "response.in_progress", response: { status: "in_progress", output: [] } },
        ...(recovered ? [
          { type: "response.output_text.delta", delta: "recovered response" },
          { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 2 } } }
        ] : [{ type: "error", code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." }])
      ].map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (recovered) success = frames.join("");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { for (const text of frames) controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } });
    };
    const result = await finishWithRetryTimers(t, request({ model: "alias", stream: true, input: "test metadata before overload" }, (response) => { downstream = response; }, {}, "/proxy/v1/responses"));
    assert.equal(calls, 3);
    assert.equal(result.statusCode, recovers ? 200 : 502);
    if (recovers) assert.equal(result.text(), success, "only the successful attempt's metadata and output reach the client");
    else assert.match(result.text(), /overloaded/);
    const summary = store.listRequestLogs()[0];
    assert.equal(summary.attemptCount, 3);
    const attempts = store.getRequestLog(summary.id)!.calls[0].attempts;
    assert.equal(attempts.filter((attempt) => attempt.result.statusCode === 599).length, recovers ? 2 : 3);
    const totals = store.usageReport().totals;
    assert.equal(totals.requests, 3);
    assert.equal(totals.downstreamRequests, 1);
    assert.equal(totals.totalTokens, recovers ? 12 : 0);
    assert.equal(totals.missingUsageRequests, recovers ? 2 : 3);
  });
});

test("599 never replays a stream after forwarding partial output", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 10 }] });
  let calls = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) { controller = stream; stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n')); }
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const result = await request({ model: "alias", stream: true, messages: [{ role: "user", content: "do not duplicate" }] }, (response) => {
    const write = response.write.bind(response);
    response.write = (chunk) => { const ok = write(chunk); controller.error(new TypeError("terminated")); return ok; };
  });
  assert.equal(calls, 1);
  assert.equal(result.text().split("partial answer").length - 1, 1);
  assert.equal(store.listRequestLogs()[0].result.statusCode, 599);
  assert.equal(store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts[0].result.streamStartedWith, "data");
});

test("599 exhausts its configured budget on the same target before failing over", async (t) => {
  for (const fixture of [
    { kind: "HTTP", count: 2 },
    { kind: "transport via proxy", count: 10 },
    { kind: "transport via proxy", count: 0 },
    { kind: "transport via proxy", count: undefined }
  ]) await t.test(`${fixture.kind}, retries=${fixture.count ?? "unconfigured"}`, { timeout: 2000 }, async (t) => {
    const { store, request } = setup(t, true);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: fixture.count === undefined ? [] : [{ statusCode: 599, count: fixture.count }] });
    if (fixture.kind.includes("proxy")) {
      const site = store.getDb().sites[0];
      store.upsertSite({ ...site, addresses: site.addresses.map((address) => ({ ...address, proxy: { mode: "custom", url: "http://127.0.0.1:19999" } })) });
    }
    const hosts: string[] = [];
    globalThis.fetch = async (target) => {
      hosts.push(new URL(String(target)).host);
      if (hosts.at(-1) === "second.invalid") return Response.json({ choices: [{ message: { content: "fallback" } }] });
      if (fixture.kind === "HTTP") return Response.json({ error: { message: "HTTP 599 failure" } }, { status: 599 });
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) });
    };
    const result = await finishWithRetryTimers(t, request({ model: "alias", messages: [{ role: "user", content: "exhaust before failover" }] }));
    assert.equal(result.statusCode, 200);
    assert.match(result.text(), /fallback/);
    const primaryAttempts = (fixture.count || 0) + 1;
    assert.deepEqual(hosts, [...Array<string>(primaryAttempts).fill("first.invalid"), "second.invalid"]);
    assert.deepEqual(store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts.map((attempt) => attempt.result.statusCode), [...Array<number>(primaryAttempts).fill(599), 200]);
    assert.equal(store.usageReport().totals.requests, fixture.kind === "HTTP" ? primaryAttempts + 1 : 1);
  });
});

test("599 returns failure only after the final allowed attempt when there is no fallback", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 2 }] });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("fetch failed"); };
  const result = await finishWithRetryTimers(t, request({ model: "alias", messages: [{ role: "user", content: "exhaust retries" }] }));
  assert.equal(calls, 3);
  assert.equal(result.statusCode, 502);
  assert.match(result.text(), /fetch failed/);
  const summary = store.listRequestLogs()[0];
  assert.equal(summary.attemptCount, 3);
  const call = store.getRequestLog(summary.id)!.calls[0];
  assert.deepEqual(call.attempts.filter((attempt) => attempt.id !== call.id).map((attempt) => attempt.result.statusCode), [599, 599, 599]);
  assert.equal(store.usageReport().totals.requests, 0);
});

test("599 keeps its own configured budget when HTTP errors and transport failures alternate", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 503, count: 1 }, { statusCode: 599, count: 2 }] });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ error: { message: "busy" } }, { status: 503 });
    if (calls === 2) throw new TypeError("fetch failed");
    if (calls === 3) return Response.json({ error: { message: "temporary 599" } }, { status: 599 });
    return Response.json({ choices: [{ message: { content: "recovered" } }] });
  };
  const result = await finishWithRetryTimers(t, request({ model: "alias", messages: [{ role: "user", content: "mixed errors" }] }));
  assert.equal(result.statusCode, 200);
  assert.equal(calls, 4);
  assert.deepEqual(store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts.map((attempt) => attempt.result.statusCode), [503, 599, 599, 200]);
});

test("599 retries header timeouts and streams terminated before any output", async (t) => {
  for (const stream of [false, true]) await t.test(stream ? "stream terminated" : "header timeout", { timeout: 2000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ requestTimeoutSeconds: 1, upstreamRetryCodeCounts: [{ statusCode: 599, count: 1 }] });
    let calls = 0;
    globalThis.fetch = async (_target, init) => {
      if (++calls > 1) return stream
        ? new Response('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
        : Response.json({ choices: [{ message: { content: "recovered" } }] });
      if (!stream) return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')); },
        pull(controller) { controller.error(new TypeError("terminated")); }
      }), { headers: { "content-type": "text/event-stream" } });
    };
    const result = await finishWithRetryTimers(t, request({ model: "alias", stream, messages: [{ role: "user", content: "recover early failure" }] }));
    assert.equal(calls, 2);
    assert.equal(result.statusCode, 200);
    assert.match(result.text(), /recovered/);
    const attempts = store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts;
    assert.deepEqual(attempts.map((attempt) => attempt.result.statusCode), [599, 200]);
    assert.match(attempts[0].result.body, stream ? /terminated/ : /响应头超时/);
  });
});

test("599 backoff stops immediately when the client cancels, even with 499 retries configured", { timeout: 1000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 10 }, { statusCode: 499, count: 1 }] });
  let calls = 0;
  let downstream!: ResponseRecorder;
  let timer: ReturnType<typeof setTimeout>;
  t.after(() => clearTimeout(timer));
  globalThis.fetch = async () => {
    calls++;
    timer = setTimeout(() => downstream.destroy(), 20);
    return Response.json({ error: { message: "temporary failure" } }, { status: 599 });
  };
  await request({ model: "alias", messages: [{ role: "user", content: "cancel retry" }] }, (response) => { downstream = response; });
  assert.equal(calls, 1);
  assert.equal(store.listRequestLogs()[0].result.status, "cancelled");
  assert.equal(store.listRequestLogs()[0].result.statusCode, 499);
});

test("599 retries Codex response.failed for streaming and non-streaming clients", async (t) => {
  for (const stream of [true, false]) await t.test(`stream=${stream}`, { timeout: 2000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 1 }] });
    store.saveCodexOAuthAccount({ accessToken: "fixture-codex-access", refreshToken: "fixture-codex-refresh", accountId: "fixture-chatgpt-account", email: "fixture@example.invalid" });
    store.createManagedAccountRoute("gpt", { name: "gpt-oauth-route", model: "gpt-fixture" });
    let calls = 0;
    let cancelled = 0;
    let downstream!: ResponseRecorder;
    globalThis.fetch = async (target) => {
      assert.equal(String(target), "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(downstream.headersSent, false);
      const failed = ++calls === 1;
      const payload = failed
        ? { type: "response.failed", response: { status: "failed", error: { code: "server_is_overloaded", message: "Codex overloaded" } } }
        : { type: "response.completed", response: { id: "resp_recovered", object: "response", status: "completed", model: "gpt-fixture", output: [{ id: "msg_recovered", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Codex recovered", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } };
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_start","status":"in_progress","output":[]}}\n\n'));
          if (!failed) controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_recovered","output_index":0,"content_index":0,"delta":"Codex recovered"}\n\n'));
          controller.enqueue(new TextEncoder().encode(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`));
        },
        cancel() { cancelled++; }
      }), { headers: { "content-type": "text/event-stream" } });
    };
    const result = await finishWithRetryTimers(t, request({ model: "gpt-oauth-route", stream, messages: [{ role: "user", content: "recover Codex" }] }, (response) => { downstream = response; }));
    assert.equal(calls, 2);
    assert.equal(cancelled, 2);
    assert.equal(result.statusCode, 200);
    assert.match(result.text(), /Codex recovered/);
    assert.doesNotMatch(result.text(), /Codex overloaded|response.failed/);
    assert.deepEqual(store.getRequestLog(store.listRequestLogs()[0].id)!.calls[0].attempts.map((attempt) => attempt.result.statusCode), [599, 200]);
    const totals = store.usageReport().totals;
    assert.equal(totals.requests, 2); assert.equal(totals.downstreamRequests, 1); assert.equal(totals.totalTokens, 13);
  });
});

test("Codex Responses Lite without Content-Type retries overloads before exposing any events", async (t) => {
  for (const { recovers, retries } of [{ recovers: true, retries: 10 }, { recovers: false, retries: 10 }, { recovers: true, retries: 100 }]) await t.test(`${recovers ? "recovers on" : "exhausts"} retry ${retries}`, { timeout: 5000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: retries }] });
    store.saveCodexOAuthAccount({ accessToken: "fixture-codex-access", refreshToken: "fixture-codex-refresh", accountId: "fixture-chatgpt-account", email: "fixture@example.invalid" });
    const headerTemplate = store.upsertHeaderTemplate({ name: "Codex fixture", headersText: `User-Agent: ${CODEX_USER_AGENT}` });
    const route = store.createManagedAccountRoute("gpt", { name: "gpt-oauth-route", model: "gpt-fixture" });
    store.upsertRoute({ ...route, headerTemplateId: headerTemplate.id });
    let calls = 0;
    let downstream!: ResponseRecorder;
    globalThis.fetch = async (target, init) => {
      assert.equal(String(target), "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(new Headers(init?.headers).get("x-openai-internal-codex-responses-lite"), "true");
      assert.equal(downstream.headersSent, false, "even the first SSE frame must wait until the attempt has useful output");
      assert.equal(downstream.text(), "");
      calls++;
      const frames = [
        { type: "response.created", response: { id: `resp_${calls}`, status: "in_progress", output: [], instructions: "fixture instruction ".repeat(5000) }, sequence_number: 0 },
        { type: "response.in_progress", response: { id: `resp_${calls}`, status: "in_progress", output: [] }, sequence_number: 1 },
        ...(recovers && calls === retries + 1 ? [
          { type: "response.output_text.delta", delta: "recovered", sequence_number: 2 },
          { type: "response.completed", response: { id: `resp_${calls}`, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }, sequence_number: 3 }
        ] : [{ type: "error", error: { code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." }, sequence_number: 2 }])
      ];
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
          controller.close();
        }
      }));
      assert.equal(response.headers.get("content-type"), null);
      return response;
    };
    const result = await finishWithRetryTimers(t, request({ model: "gpt-oauth-route", stream: true, reasoning: { context: "all_turns" }, parallel_tool_calls: false, input: "test real Responses Lite framing" }, (response) => { downstream = response; }, { "user-agent": CODEX_USER_AGENT, "x-openai-internal-codex-responses-lite": "true" }, "/proxy/v1/responses"), retries * 4 + 40);
    assert.equal(calls, retries + 1);
    const summary = store.listRequestLogs()[0];
    assert.equal(summary.attemptCount, retries + 1);
    const call = store.getRequestLog(summary.id)!.calls[0];
    assert.equal(call.attempts.filter((attempt) => attempt.result.statusCode === 599).length, recovers ? retries : retries + 1);
    if (recovers) {
      assert.equal(result.statusCode, 200);
      assert.match(result.text(), /recovered/);
      assert.equal((result.text().match(/event: response.created/g) || []).length, 1);
      assert.doesNotMatch(result.text(), /server_is_overloaded/);
    } else {
      assert.equal(result.statusCode, 502);
      assert.match(result.text(), /overloaded/);
      assert.doesNotMatch(result.text(), /event: response.created/);
    }
    assert.equal(store.usageReport().totals.requests, retries + 1);
  });
});

test("Codex keeps retrying a later overload after keepalive and records all attempts in the same conversation", async (t) => {
  for (const { retries, recovers } of [
    { retries: 2, recovers: true },
    { retries: 2, recovers: false },
    { retries: 100, recovers: true },
    { retries: 100, recovers: false },
    { retries: 0, recovers: false },
    { retries: undefined, recovers: false }
  ]) await t.test(`${recovers ? "recovers" : "fails"}, retries=${retries ?? "unconfigured"}`, { timeout: 5000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: retries === undefined ? [{ statusCode: 500, count: 1000 }] : [{ statusCode: 599, count: retries }] });
    store.saveCodexOAuthAccount({ accessToken: "fixture-codex-access", refreshToken: "fixture-codex-refresh", accountId: "fixture-chatgpt-account", email: "fixture@example.invalid" });
    store.createManagedAccountRoute("gpt", { name: "gpt-heartbeat-route", model: "gpt-fixture" });
    let calls = 0;
    let cancelled = 0;
    let downstream!: ResponseRecorder;
    const sse = (value: { type: string; [key: string]: unknown }) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
    globalThis.fetch = async (target) => {
      assert.equal(String(target), "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(downstream.headersSent, false, "neither previous requests nor keepalive may commit this response");
      assert.equal(downstream.text(), "");
      const attempt = ++calls;
      const succeeds = attempt === 1 || (recovers && attempt === (retries || 0) + 2);
      const answer = attempt === 1 ? "earlier reply" : "recovered after keepalive";
      const frames = [sse({ type: "response.created", response: { id: `resp_heartbeat_${attempt}`, output: [] } })];
      // First 599 is caught; on later attempts a real data-bearing heartbeat previously
      // bypassed preparation, forwarding the overload and stopping after just one retry.
      if (attempt >= 3 || !retries) frames.push(sse({ type: "keepalive" }), 'event: keepalive\ndata: keepalive\n\n');
      frames.push(...(succeeds ? [
        sse({ type: "response.output_text.delta", delta: answer }),
        sse({ type: "response.completed", response: { id: `resp_heartbeat_${attempt}`, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
      ] : [sse({ type: "error", error: { code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." } })]));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          if (!succeeds) controller.close();
        },
        cancel() { cancelled++; }
      }));
    };
    const headers = { "session-id": "fixture-heartbeat-session", "x-samapi-turn-id": "fixture-heartbeat-turn", "user-agent": CODEX_USER_AGENT };
    const body = { model: "gpt-heartbeat-route", stream: true, input: "continue the same conversation" };
    const first = await finishWithRetryTimers(t, request(body, (response) => { downstream = response; }, headers, "/proxy/v1/responses"));
    assert.match(first.text(), /earlier reply/);
    const originalId = store.listRequestLogs()[0].id;
    const result = await finishWithRetryTimers(t, request(body, (response) => { downstream = response; }, headers, "/proxy/v1/responses"), (retries || 0) * 4 + 40);
    assert.equal(calls, (retries || 0) + 2);
    assert.equal(cancelled, recovers ? 2 : 1, "completed streams release idle upstream connections");
    const summary = store.listRequestLogs()[0];
    assert.equal(summary.id, originalId);
    assert.equal(store.requestLogCount(), 1);
    assert.equal(summary.requestCount, 2);
    assert.equal(summary.attemptCount, calls);
    const log = store.getRequestLog(originalId)!;
    assert.equal(log.calls.length, 2);
    assert.equal(log.calls[0].attempts[0].result.streamStartedWith, "response.output_text.delta");
    for (const attempt of log.calls[1].attempts) {
      assert.equal(attempt.result.streamStartedWith, attempt.result.statusCode === 200 ? "response.output_text.delta" : undefined);
    }
    // Exhaustion also records the aggregate 502 returned by SamAPI, after all upstream 599s.
    assert.deepEqual(log.calls[1].attempts.map((attempt) => attempt.result.statusCode), [...Array<number>((retries || 0)).fill(599), recovers ? 200 : 599, ...(recovers ? [] : [502])]);
    if (recovers) {
      assert.equal(result.statusCode, 200);
      assert.match(result.text(), /recovered after keepalive/);
      assert.equal((result.text().match(/event: response.created/g) || []).length, 1);
      assert.doesNotMatch(result.text(), /server_is_overloaded|earlier reply/);
    } else {
      assert.equal(result.statusCode, 502);
      assert.match(result.text(), /overloaded/);
      assert.doesNotMatch(result.text(), /event:|earlier reply/);
    }
    assert.equal(store.usageReport().totals.requests, calls);
    assert.equal(store.usageReport().totals.downstreamRequests, 2);
  });
});

test("Codex Lite empty output items preserve the retry budget after earlier output in the same conversation", async (t) => {
  for (const { client, retries, recovers } of [
    { client: "responses", retries: 100, recovers: true },
    { client: "responses", retries: 100, recovers: false },
    { client: "chat/completions", retries: 3, recovers: true },
    { client: "responses", retries: 0, recovers: false },
    { client: "responses", retries: undefined, recovers: false }
  ]) await t.test(`${client}: retries=${retries ?? "unconfigured"}, recovers=${recovers}`, { timeout: 5000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: retries === undefined ? [{ statusCode: 500, count: 1000 }] : [{ statusCode: 599, count: retries }] });
    store.saveCodexOAuthAccount({ accessToken: "fixture-codex-access", refreshToken: "fixture-codex-refresh", accountId: "fixture-chatgpt-account", email: "fixture@example.invalid" });
    store.createManagedAccountRoute("gpt", { name: "gpt-lite-route", model: "gpt-fixture" });
    let calls = 0;
    let downstream!: ResponseRecorder;
    globalThis.fetch = async (target) => {
      assert.equal(String(target), "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(downstream.headersSent, false, "empty output items must not commit this downstream request");
      assert.equal(downstream.text(), "");
      const attempt = ++calls;
      const succeeds = attempt === 1 || (recovers && attempt === (retries || 0) + 2);
      const answer = attempt === 1 ? "earlier reply" : "recovered after empty items";
      const frames: Record<string, unknown>[] = [{ type: "response.created", response: { id: `resp_lite_${attempt}`, output: [] } }];
      // Reproduce the logged path: two 599s retry, then the next attempt starts an
      // empty item before overload. Responses Lite may omit the empty summary/content.
      if (attempt >= 4 || !retries) frames.push(
        { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_empty" } },
        { type: "response.reasoning_summary_part.added", part: { type: "summary_text" } },
        { type: "response.reasoning_summary_text.delta", delta: "" },
        { type: "response.output_item.done", item: { type: "reasoning", id: "rs_empty", summary: null, encrypted_content: "opaque context" } },
        { type: "response.output_item.added", item: { type: "message", role: "assistant", content: null } }
      );
      frames.push(...(succeeds ? [
        { type: "response.output_text.delta", delta: answer, item_id: "msg_reply", output_index: 1, content_index: 0 },
        { type: "response.completed", response: { id: `resp_lite_${attempt}`, object: "response", status: "completed", model: "gpt-fixture", output: [{ id: "msg_reply", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }
      ] : [{ type: "error", error: { code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." } }]));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
          controller.close();
        }
      }));
    };
    const headers = { "session-id": "fixture-lite-session", "x-samapi-turn-id": "fixture-lite-turn", "user-agent": CODEX_USER_AGENT, "x-openai-internal-codex-responses-lite": "true" };
    const body = { model: "gpt-lite-route", stream: true, ...(client === "responses" ? { input: "continue the same conversation" } : { messages: [{ role: "user", content: "continue the same conversation" }] }) };
    const first = await finishWithRetryTimers(t, request(body, (response) => { downstream = response; }, headers, `/proxy/v1/${client}`));
    assert.match(first.text(), /earlier reply/);
    const originalId = store.listRequestLogs()[0].id;
    const result = await finishWithRetryTimers(t, request(body, (response) => { downstream = response; }, headers, `/proxy/v1/${client}`), (retries || 0) * 4 + 40);
    assert.equal(calls, (retries || 0) + 2);
    assert.equal(store.requestLogCount(), 1);
    const summary = store.listRequestLogs()[0];
    assert.equal(summary.id, originalId);
    assert.equal(summary.requestCount, 2);
    assert.equal(summary.attemptCount, calls);
    const log = store.getRequestLog(originalId)!;
    assert.equal(log.calls.length, 2);
    assert.equal(log.calls[1].attempts.filter((attempt) => attempt.result.statusCode === 599).length, recovers ? retries : (retries || 0) + 1);
    assert.equal(result.statusCode, recovers ? 200 : 502);
    assert.match(result.text(), recovers ? /recovered after empty items/ : /overloaded/);
    if (recovers) assert.doesNotMatch(result.text(), /server_is_overloaded|earlier reply/);
    else assert.doesNotMatch(result.text(), /event:|rs_empty/);
    assert.equal(store.usageReport().totals.requests, calls);
    assert.equal(store.usageReport().totals.downstreamRequests, 2);
  });
});

test("actual tool-call responses and client callbacks update the same turn and keep billing per HTTP request", async (t) => {
  const { store, request } = setup(t);
  let calls = 0;
  const toolCall = { id: "call-project-files", type: "function", function: { name: "list_files", arguments: '{"path":"."}' } };
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ id: `response-${calls}`, choices: [{ message: calls === 1
      ? { role: "assistant", content: "查看项目文件", tool_calls: [toolCall] }
      : { role: "assistant", content: "分析完成" } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
  };
  const history = [{ role: "user", content: "过去的问题" }, { role: "assistant", content: "过去的回答" }, { role: "user", content: "分析项目" }];
  await request({ model: "alias", messages: history });
  const first = store.listRequestLogs()[0];
  assert.equal(first.phase, "waiting-tools");
  assert.equal(first.msg, "分析项目");
  await request({ model: "alias", messages: [...history,
    { role: "assistant", content: "查看项目文件", tool_calls: [toolCall] },
    { role: "tool", tool_call_id: "call-project-files", content: "README.md\npackage.json\nsrc/" }
  ] });
  assert.equal(store.requestLogCount(), 1);
  const log = store.getRequestLog(first.id)!;
  assert.equal(log.phase, "returned");
  assert.equal(log.calls.length, 2);
  assert.equal(log.tools.length, 1);
  assert.equal(log.tools[0].name, "list_files");
  assert.equal(log.tools[0].status, "success");
  assert.match(log.tools[0].result, /package.json/);
  assert.equal(log.result.body, "分析完成");
  assert.equal(store.usageReport().totals.requests, 2);
  assert.equal(store.usageReport().totals.downstreamRequests, 2);
  assert.equal(store.usageReport().totals.totalTokens, 34);
});

test("a running stream exposes partial progress before completion and updates the same log in place", { timeout: 3000 }, async (t) => {
  const { store, request } = setup(t);
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  let markFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => { markFirstWrite = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"正在分析"}}]}\n\n'));
    }
  }), { headers: { "content-type": "text/event-stream" } });
  const pending = request({ model: "alias", stream: true, messages: [{ role: "user", content: "分析项目" }] }, (response) => {
    const write = response.write.bind(response);
    response.write = (chunk) => { const result = write(chunk); markFirstWrite(); return result; };
  });
  await firstWrite;
  const started = store.listRequestLogs()[0];
  assert.equal(started.phase, "running");
  assert.equal(store.getRequestLog(started.id)?.result.body, "正在分析");
  upstreamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"，完成"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n'));
  await pending;
  assert.equal(store.requestLogCount(), 1);
  assert.equal(store.getRequestLog(started.id)?.phase, "returned");
  assert.equal(store.getRequestLog(started.id)?.result.body, "正在分析，完成");
  assert.equal(store.usageReport().totals.totalTokens, 5);
});

test("managed Claude accounts use native auth and protocol, fail over on invalid credentials, and attribute usage to the client", async (t) => {
  const { store, request } = setup(t);
  const first = store.createManagedAccount({ provider: "claude", label: "first", secret: "fixture-claude-first", models: ["claude-fixture"] });
  const second = store.createManagedAccount({ provider: "claude", label: "second", secret: "fixture-claude-second", models: ["claude-fixture"] });
  store.createManagedAccountRoute("claude", { name: "claude-route", model: "claude-fixture" });
  const keys: string[] = [];
  globalThis.fetch = async (target, init) => {
    assert.equal(String(target), "https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null); assert.equal(headers.get("anthropic-version"), "2023-06-01");
    keys.push(headers.get("x-api-key")!);
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, "claude-fixture"); assert.equal(body.messages[0].role, "user");
    if (keys.length === 1) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid credential" } }, { status: 401 });
    return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-fixture", content: [{ type: "text", text: "Claude fixture reply" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 3 } });
  };
  const result = await request({ model: "claude-route", messages: [{ role: "user", content: "test account failover" }] });
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.text()).choices[0].message.content, "Claude fixture reply");
  assert.deepEqual(keys, ["fixture-claude-first", "fixture-claude-second"]);
  assert.equal(store.temporaryAccountCheckTarget(first.id)?.account.availability, "unavailable");
  assert.equal(store.temporaryAccountCheckTarget(second.id)?.account.availability, "available");
  const usage = store.usageReport();
  assert.equal(usage.totals.requests, 2); assert.equal(usage.totals.downstreamRequests, 1); assert.equal(usage.totals.totalTokens, 133); assert.equal(usage.clients[0].apiKeyName, "fixture-client");
});

test("managed DeepSeek requests follow the selected account and preserve OpenAI-compatible billing", async (t) => {
  const { store, request } = setup(t);
  store.createManagedAccount({ provider: "deepseek", label: "first", secret: "fixture-deepseek-first", models: ["deepseek-chat"] });
  const second = store.createManagedAccount({ provider: "deepseek", label: "second", secret: "fixture-deepseek-second", models: ["deepseek-chat"] });
  store.setManagedAccountPolicy("deepseek", { preferredAccountId: second.id });
  store.createManagedAccountRoute("deepseek", { name: "deepseek-route", model: "deepseek-chat" });
  globalThis.fetch = async (target, init) => {
    assert.equal(String(target), "https://api.deepseek.com/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-deepseek-second");
    return Response.json({ choices: [{ message: { role: "assistant", content: "DeepSeek reply" } }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } });
  };
  const result = await request({ model: "deepseek-route", messages: [{ role: "user", content: "test default account" }] });
  assert.equal(result.statusCode, 200); assert.equal(store.usageReport().totals.totalTokens, 105); assert.equal(store.usageReport().totals.cachedInputTokens, 80);
});

test("managed Claude streaming converts to client Chat SSE and records final usage instead of initial output counts", async (t) => {
  const { store, request } = setup(t);
  store.createManagedAccount({ provider: "claude", label: "stream", secret: "fixture-claude-stream", models: ["claude-fixture"] });
  store.createManagedAccountRoute("claude", { name: "claude-stream", model: "claude-fixture" });
  const frames = [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好，流式回复" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: "message_stop" }
  ];
  globalThis.fetch = async () => new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const response = await request({ model: "claude-stream", stream: true, messages: [{ role: "user", content: "stream test" }] });
  assert.equal(response.statusCode, 200);
  assert.match(response.text(), /你好，流式回复/);
  assert.match(response.text(), /\[DONE\]/);
  const totals = store.usageReport().totals;
  assert.equal(totals.totalTokens, 129); assert.equal(totals.outputTokens, 9); assert.equal(totals.cachedInputTokens, 20);
});

test("existing GPT OAuth accounts retain Codex routing and contribute Responses usage to client billing", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t);
  store.saveCodexOAuthAccount({ accessToken: "fixture-codex-access", refreshToken: "fixture-codex-refresh", accountId: "fixture-chatgpt-account", email: "fixture@example.invalid" });
  store.createManagedAccountRoute("gpt", { name: "gpt-oauth-route", model: "gpt-fixture" });
  let cancelled = false;
  globalThis.fetch = async (target, init) => {
    assert.equal(String(target), "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-codex-access");
    const response = { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "gpt-fixture", output: [{ id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Codex fixture reply", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  };
  const result = await request({ model: "gpt-oauth-route", messages: [{ role: "user", content: "test existing GPT account" }] });
  assert.equal(result.statusCode, 200);
  assert.match(result.text(), /Codex fixture reply/);
  assert.equal(store.usageReport().totals.totalTokens, 13);
  assert.equal(store.usageReport().clients[0].apiKeyName, "fixture-client");
  assert.equal(cancelled, true);
});
