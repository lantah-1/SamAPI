import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { captureUsageResponse, createUsageCapture, requestServiceTier, usageFields } from "../server/usage-capture.js";
import { JsonStore } from "../server/store/index.js";
import { usageCostNano, validatePrice } from "../server/store/usage.js";
import type { UsageRecordInput } from "../shared/usage.js";
import { UsageSummary } from "../src/views/UsageView.js";

test("usage normalizes OpenAI, Responses, DeepSeek, Anthropic and Gemini without double charging cached or reasoning tokens", () => {
  assert.deepEqual(usageFields({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 20 } }), { inputTokens: 100, cachedInputTokens: 30, outputTokens: 50 });
  assert.deepEqual(usageFields({ input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 30 } }), { inputTokens: 100, cachedInputTokens: 30, outputTokens: 50 });
  assert.deepEqual(usageFields({ prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 }), { inputTokens: 100, cachedInputTokens: 30, outputTokens: 50 });
  assert.deepEqual(usageFields({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 }), { inputTokens: 150, cachedInputTokens: 30, cacheWriteInputTokens: 20, outputTokens: 50 });
  assert.deepEqual(usageFields({ promptTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 20, cachedContentTokenCount: 10 }), { inputTokens: 100, cachedInputTokens: 10, outputTokens: 50 });
});

test("incremental parser ignores user-generated usage examples and merges split cumulative SSE counts exactly once", () => {
  const source = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 }, content: [] } })}\n\n`,
    `data: ${JSON.stringify({ delta: { text: 'Example: {"usage":{"input_tokens":9000,"output_tokens":9000}} \\"' } })}\n\n`,
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 60 } })}\n\n`,
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 60 } })}\n\ndata: [DONE]\n\n`
  ].join("");
  for (const width of [1, 2, 7, 100, source.length]) {
    const capture = createUsageCapture();
    for (let offset = 0; offset < source.length; offset += width) capture.push(source.slice(offset, offset + width));
    assert.deepEqual(capture.result(), { inputTokens: 150, cachedInputTokens: 30, cacheWriteInputTokens: 20, outputTokens: 60, totalTokens: 210 });
  }
  const capture = createUsageCapture();
  capture.push(JSON.stringify({ choices: [{ message: { usage: { input_tokens: 900, output_tokens: 900 } } }], response: { usage: { input_tokens: 5, output_tokens: 2 } } }));
  assert.equal(capture.result()?.totalTokens, 7);
});

test("unknown, malformed and incomplete usage stays unknown; large reply text does not interfere with late usage", () => {
  for (const source of ['{"choices":[]}', '{"usage":{"prompt_tokens":10}}', '{"usage":{"input_tokens":-1,"output_tokens":10}}', '{"usage":{"input_tokens":"10","output_tokens":10}}']) {
    const capture = createUsageCapture(); capture.push(source); assert.equal(capture.result(), undefined);
  }
  const capture = createUsageCapture();
  capture.push('{"choices":[{"message":{"content":"');
  for (let i = 0; i < 200; i++) capture.push("x".repeat(10000));
  capture.push('"}}],"usage":{"prompt_tokens":20,"completion_tokens":0}}');
  assert.equal(capture.result()?.totalTokens, 20);
  const partial = createUsageCapture();
  partial.push('data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n');
  assert.equal(partial.result(), undefined, "an interrupted Anthropic stream must not bill its initial output count as final usage");
  const gemini = createUsageCapture();
  gemini.push('[{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}},{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4}}]');
  assert.equal(gemini.result()?.totalTokens, 14);
});

test("usage response tap preserves bytes, headers, status and records EOF or cancellation once", async () => {
  const context = { requestId: "req", apiKeyId: "client", apiKeyName: "Client", providerId: "provider", providerName: "Provider", model: "model" };
  const records: UsageRecordInput[] = [];
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n');
  const original = new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { "content-type": "text/event-stream", "x-fixture": "preserved" } });
  const tapped = captureUsageResponse(original, context, (record) => records.push(record));
  assert.deepEqual(new Uint8Array(await tapped.arrayBuffer()), bytes);
  assert.equal(tapped.headers.get("x-fixture"), "preserved");
  assert.equal(records.length, 2);
  assert.equal(records[0].id, records[1].id);
  assert.equal(records[1].usage?.totalTokens, 3);
  let cancelled = false;
  const cancelledRecords: UsageRecordInput[] = [];
  const idle = captureUsageResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })), context, (record) => cancelledRecords.push(record));
  await idle.body!.cancel();
  assert.equal(cancelled, true);
  assert.equal(cancelledRecords.length, 2);
  assert.equal(cancelledRecords[1].usage, undefined);
});

test("service tier capture reads envelope metadata, ignores generated fields and uses the last upstream tier", () => {
  const wire = [
    { type: "response.created", response: { service_tier: "fast" } },
    { choices: [{ message: { service_tier: "ultrafast", content: '{"service_tier":"scale"}' } }] },
    { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 5 }, service_tier: "default" } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  for (const width of [1, 7, wire.length]) {
    const capture = createUsageCapture();
    for (let i = 0; i < wire.length; i += width) capture.push(wire.slice(i, i + width));
    assert.equal(capture.serviceTier(), "default");
    assert.equal(capture.result()?.totalTokens, 105);
  }
  const fake = createUsageCapture();
  fake.push(JSON.stringify({ output: [{ service_tier: "priority" }], choices: [{ message: { service_tier: "priority" } }] }));
  assert.equal(fake.serviceTier(), undefined);
  const anthropic = createUsageCapture();
  anthropic.push(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 5, service_tier: "standard" } }));
  assert.equal(anthropic.serviceTier(), "default");
  assert.equal(requestServiceTier('{"service_tier":"fast"}'), "fast");
  assert.equal(requestServiceTier({ messages: [{ content: '{"service_tier":"fast"}' }] }), undefined);
});

test("response service tier overrides the requested tier before pricing and cannot be downgraded by a late estimate", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-service-tier-"));
  const store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = { id: "fixture", name: "Fixture", url: "https://example.com/pricing" };
  const prices = { providerId: "", model: "model", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 2.5, outputUsdPerMillion: 8,
    source, serviceTiers: { priority: { inputUsdPerMillion: 4, cachedInputUsdPerMillion: 1, cacheWriteUsdPerMillion: 5, outputUsdPerMillion: 16 } } };
  store.saveOfficialModelPrices([prices], { ...source, status: "success", modelCount: 1, lastSuccessAt: "2026-09-11T00:00:00Z" });
  const context = { requestId: "req", apiKeyId: "client", apiKeyName: "Client", providerId: "provider", providerName: "Provider", model: "model", serviceTier: "priority" };
  const payload = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 } };
  const records: UsageRecordInput[] = [];
  await captureUsageResponse(Response.json({ usage: payload, service_tier: "default" }), context, (record) => { records.push(record); store.recordUsage(record); }).text();
  assert.equal(records.at(-1)?.serviceTier, "default");
  assert.equal(store.usageReport().totals.estimatedCostUsd, 0.000245);
  const final = records.at(-1)!;
  store.recordUsage({ ...final, serviceTier: "priority", estimation: { method: "content" } });
  assert.equal(store.usageReport().totals.estimatedCostUsd, 0.000245);
  await captureUsageResponse(Response.json({ usage: payload }), context, (record) => store.recordUsage(record)).text();
  assert.equal(store.usageReport().totals.estimatedCostUsd, 0.000735);
  await captureUsageResponse(Response.json({ usage: payload, service_tier: "ultrafast" }), context, (record) => store.recordUsage(record)).text();
  assert.equal(store.usageReport().totals.unpricedRequests, 1);
  assert.equal(store.priceUnpricedUsage(), 0, "unknown service tiers remain unpriced after a price refresh");
});

test("ledger filters by client and date, snapshots prices, keeps retries distinct, and survives log cleanup, key deletion and restart", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-usage-test-"));
  let store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const client = store.createApiKey("client-a");
  const price = { providerId: "", model: "model", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 8 };
  store.saveModelPrice(price);
  const input: UsageRecordInput = { id: "one", requestId: "req", apiKeyId: client.id, apiKeyName: "client-a", providerId: "p", providerName: "P", model: "model", createdAt: "2026-09-01T00:00:00.000Z", statusCode: 200 };
  store.recordUsage(input);
  store.saveModelPrice({ ...price, inputUsdPerMillion: 20 });
  const usage = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, totalTokens: 110 };
  store.recordUsage({ ...input, usage });
  store.recordUsage({ ...input, usage });
  store.recordUsage(input); // A duplicate incomplete save must not erase known usage.
  store.recordUsage({ ...input, id: "retry", createdAt: "2026-09-01T00:01:00.000Z", statusCode: 503 });
  store.recordUsage({ ...input, id: "other", requestId: "other", apiKeyId: "other", apiKeyName: "client-b", model: "unpriced", createdAt: "2026-09-01T16:00:00.000Z", usage });
  const report = store.usageReport({ apiKeyId: client.id });
  assert.equal(report.totals.requests, 2);
  assert.equal(report.totals.downstreamRequests, 1);
  assert.equal(report.totals.failedRequests, 1);
  assert.equal(report.totals.totalTokens, 110);
  assert.equal(report.totals.missingUsageRequests, 1);
  assert.equal(report.totals.estimatedCostUsd, 0.00025);
  assert.equal(store.usageReport().totals.unpricedRequests, 1);
  assert.equal(store.usageReport({ from: "2026-09-01T00:00:00Z", to: "2026-09-01T16:00:00Z" }).totals.requests, 2);
  assert.deepEqual(store.usageReport({ timezoneOffsetMinutes: 480 }).daily.map((row) => row.date), ["2026-09-02", "2026-09-01"]);
  assert.equal(store.usageReport({ apiKeyId: "' OR 1=1 --" }).totals.requests, 0);
  store.clearRequestLogs(); store.updateSettings({ maxRequestLogs: 5 }); store.deleteApiKey(client.id);
  const backup = store.exportBackup(); store.importBackup(backup);
  store.close(); store = new JsonStore(dir);
  assert.equal(store.usageReport({ apiKeyId: client.id }).totals.totalTokens, 110);
  assert.ok(store.usageReport().keys.some((key) => key.id === client.id && key.name === "client-a"));
  store.saveModelPrice({ ...price, model: "unpriced", inputUsdPerMillion: 2 });
  assert.equal(store.priceUnpricedUsage(), 1);
  assert.equal(store.priceUnpricedUsage(), 0);
  assert.equal(store.usageReport().totals.unpricedRequests, 0);
  assert.equal(store.usageReport({ apiKeyId: client.id }).totals.estimatedCostUsd, 0.00025);
  const html = renderToStaticMarkup(createElement(UsageSummary, { totals: store.usageReport().totals }));
  assert.match(html, /未返回完整用量/);
  assert.match(html, /估算消费/);
  assert.match(html, /220/);
});

test("prices support explicit free rates, provider overrides, cache writes and fixed-point rounding", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-price-test-")); const store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const usage = { inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 20, outputTokens: 10, totalTokens: 110 };
  const price = { providerId: "", model: "model", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 2.5, outputUsdPerMillion: 8 };
  assert.equal(usageCostNano(usage, price), 245000n);
  assert.equal(usageCostNano(usage, { ...price, cacheWriteUsdPerMillion: undefined }), null);
  assert.equal(usageCostNano({ ...usage, cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 1, outputTokens: 0 }, { ...price, inputUsdPerMillion: 0.0005 }), 1n);
  for (const bad of [-1, NaN, Infinity, 100001, 0.0000001]) assert.throws(() => validatePrice({ ...price, inputUsdPerMillion: bad }));
  store.saveModelPrice(price);
  store.saveModelPrice({ ...price, providerId: "p", inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, outputUsdPerMillion: 0 });
  store.recordUsage({ id: "free", requestId: "req", apiKeyId: "a", apiKeyName: "A", providerId: "p", providerName: "P", model: "model", createdAt: new Date().toISOString(), statusCode: 200, usage });
  assert.equal(store.usageReport().totals.unpricedRequests, 0);
  assert.equal(store.usageReport().totals.estimatedCostUsd, 0);
  assert.throws(() => store.usageReport({ from: "invalid" }));
  assert.throws(() => store.usageReport({ from: "2026-09-02", to: "2026-09-01" }));
});

test("historical pricing processes multiple bounded batches without skipping or revisiting unpriceable rows", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-usage-batches-")); const store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 1005; i++) store.recordUsage({ id: `usage-${String(i).padStart(5, "0")}`, requestId: String(i), apiKeyId: "client", apiKeyName: "Client", providerId: "p", providerName: "P", model: i % 2 ? "priced" : "unknown", createdAt: new Date().toISOString(), statusCode: 200, usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, totalTokens: 12 } });
  store.saveModelPrice({ providerId: "", model: "priced", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 1 });
  assert.equal(store.priceUnpricedUsage(), 502);
  assert.equal(store.usageReport().totals.unpricedRequests, 503);
  assert.equal(store.priceUnpricedUsage(), 0);
});
