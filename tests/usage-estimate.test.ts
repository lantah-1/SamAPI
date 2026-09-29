import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { captureUsageResponse, usageFields } from "../server/usage-capture.js";
import { createOutputTokenEstimate, estimateRequestTokens, estimateTextTokens, tokenEncoding } from "../server/usage-estimate.js";
import { UsageStore } from "../server/store/usage.js";
import type { UsageRecordInput } from "../shared/usage.js";
import { UsageSummary } from "../src/views/UsageView.js";

const context = { requestId: "req", apiKeyId: "client", apiKeyName: "Client", providerId: "provider", providerName: "Provider", model: "model" };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const encoder = new TextEncoder();

// Reference counts from Python tiktoken 0.14.0, ordinary text (no special tokens).
const tokenizerCases = [
  ["目前，账号可以在常规额度耗尽后继续使用 Credits 余额。请检查本次请求实际使用的账号、模型名称、输入和输出 token 数量，以及缓存命中的计费方式。重试请求应当独立记录，但同一条流式响应里的累计用量不能重复相加。如果上游没有返回完整 usage，需要明确标注哪些数值是估算，避免把估算结果当成真实账单。", 96, 137],
  ["The account can continue using its Credits balance after the regular quota is exhausted. Check which account and model handled the request, how many input and output tokens were reported, and how cached input was priced. Record retries separately, but do not add cumulative usage events from the same response more than once. When the upstream service omits usage, clearly distinguish estimated values from reported counts.", 75, 75],
  ["export const add = (a: number, b: number) => a + b;\n", 18, 18],
  ['{"name":"samapi","dependencies":{"react":"^19.0.0"},"private":true}', 22, 21],
  ["你好，世界！😀 café e\u0301", 8, 12],
  ["literal <|endoftext|> and <|fim_prefix|>", 15, 14]
] as const;

test("local tokenization matches independent tiktoken counts for prose, code, JSON and Unicode", () => {
  for (const [text, modern, legacy] of tokenizerCases) {
    assert.equal(estimateTextTokens(text, "gpt-5.6-sol"), modern);
    assert.equal(estimateTextTokens(text, "openai/gpt-4-turbo"), legacy);
  }
  assert.equal(tokenEncoding("gpt-4.1"), "o200k_base");
  assert.equal(tokenEncoding("gpt-4o"), "o200k_base");
  assert.equal(tokenEncoding("gpt-3.5-turbo"), "cl100k_base");
});

test("tool data and schema fields count as input while typed binary payloads stay excluded", () => {
  const text = tokenizerCases[0][0];
  const tool = (data: string) => ({ contents: [{ role: "user", parts: [{ functionResponse: { name: "lookup", response: { data } } }] }] });
  assert.equal(estimateRequestTokens(tool(text))! - estimateRequestTokens(tool(""))!, 96);
  const schema = (description: string) => ({ tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { data: { type: "string", description } } } } }] });
  assert.equal(estimateRequestTokens(schema(text))! - estimateRequestTokens(schema(""))!, 96);
  const binary = (data: string) => ({ contents: [{ parts: [{ text: "what is this?" }, { inlineData: { mimeType: "image/png", data } }] }] });
  assert.equal(estimateRequestTokens(binary("x".repeat(1000000))), estimateRequestTokens(binary("")));
});

test("streaming tokenization joins delta fragments and escaped Unicode before counting", () => {
  const text = "Hello, world! We're testing token boundaries. 你好！😀";
  for (const model of ["gpt-5.6-sol", "gpt-4-turbo"]) for (const typeLast of [false, true]) {
    const wire = Array.from(text).map((delta) => frame(typeLast ? { delta, type: "response.output_text.delta" } : { type: "response.output_text.delta", delta })).join("")
      .replace(/😀/g, "\\ud83d\\ude00");
    for (const width of [1, 7, wire.length]) {
      const output = createOutputTokenEstimate(model);
      for (let i = 0; i < wire.length; i += width) output.push(wire.slice(i, i + width));
      assert.equal(output.result().outputTokens, model === "gpt-5.6-sol" ? 13 : 16);
    }
  }
});

function setup(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "samapi-usage-estimate-"));
  const sql = new Database(path.join(directory, "usage.sqlite"));
  const store = new UsageStore(sql);
  t.after(() => { sql.close(); rmSync(directory, { recursive: true, force: true }); });
  return { sql, store };
}

test("input estimates include full history, instructions and tools without counting opaque payloads", () => {
  const base = { messages: [{ role: "user", content: "hello" }] };
  const short = estimateRequestTokens(base)!;
  assert.ok(short > 0);
  const full = { ...base, instructions: "system instruction ".repeat(100), tools: [{ type: "function", name: "read_file", parameters: { type: "object", description: "schema details ".repeat(100) } }] };
  assert.ok(estimateRequestTokens(full)! > short + 400);
  assert.ok(estimateRequestTokens({ messages: [{ role: "assistant", content: "earlier history ".repeat(100) }, ...base.messages] })! > short + 200);
  const opaque = { ...base, input: [{ type: "reasoning", encrypted_content: "a".repeat(1000000) }, { type: "input_image", image_url: `data:image/png;base64,${"a".repeat(1000000)}` }] };
  assert.ok(estimateRequestTokens(opaque)! < short + 100);
  assert.equal(estimateRequestTokens(JSON.stringify(full)), estimateRequestTokens(full));
  assert.equal(estimateRequestTokens("not a request body"), undefined);
});

test("output estimates count reasoning and tool arguments once across deltas and repeated terminal snapshots", () => {
  const reasoning = "分析问题，然后调用工具";
  const answer = "The answer is ready.";
  const args = '{"path":"你好.txt"}';
  const output = [{ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }], encrypted_content: "a".repeat(100000) },
    { type: "message", content: [{ type: "output_text", text: answer }] }, { type: "function_call", name: "read_file", arguments: args }];
  const terminal = frame({ type: "response.completed", response: { output } });
  const wire = frame({ type: "response.created", response: { instructions: "ignored instruction ".repeat(10000), output: [] } })
    + frame({ type: "response.reasoning_summary_text.delta", delta: reasoning }) + frame({ type: "response.output_text.delta", delta: answer })
    + frame({ type: "response.function_call_arguments.delta", delta: args }) + terminal + terminal;
  for (const size of [1, 7, 16384, wire.length]) {
    const capture = createOutputTokenEstimate();
    for (let i = 0; i < wire.length; i += size) capture.push(wire.slice(i, i + size));
    assert.equal(capture.result().outputTokens, estimateTextTokens(reasoning + answer + "read_file" + args));
    assert.equal(capture.result().failed, false);
  }
});

test("large JSON replies and all supported output shapes produce estimates without log truncation", () => {
  const content = 'code\\example "你好"\n'.repeat(20000);
  const cases = [
    JSON.stringify({ choices: [{ message: { content } }] }),
    JSON.stringify({ output_text: content }),
    frame({ choices: [{ delta: { content } }] }),
    JSON.stringify({ content: [{ type: "thinking", thinking: content }] }),
    frame({ type: "content_block_delta", delta: { type: "text_delta", text: content } }),
    JSON.stringify([{ candidates: [{ content: { parts: [{ text: content }] } }] }])
  ];
  for (const wire of cases) {
    const capture = createOutputTokenEstimate();
    for (let offset = 0; offset < wire.length; offset += 4096) capture.push(wire.slice(offset, offset + 4096));
    assert.equal(capture.result().outputTokens, estimateTextTokens(content));
  }
  const errors = createOutputTokenEstimate();
  errors.push(frame({ error: { message: "a long error is not generated content" } }));
  assert.deepEqual(errors.result(), { outputTokens: 0, failed: true });
});

test("reported total tokens recover missing fields without estimates", () => {
  assert.deepEqual(usageFields({ prompt_tokens: 100, total_tokens: 150 }), { inputTokens: 100, outputTokens: 50 });
  assert.deepEqual(usageFields({ completion_tokens: 50, total_tokens: 150 }), { inputTokens: 100, outputTokens: 50 });
  assert.deepEqual(usageFields({ promptTokenCount: 100, totalTokenCount: 160, thoughtsTokenCount: 10 }), { inputTokens: 100, outputTokens: 60 });
  assert.deepEqual(usageFields({ prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 5 }), { inputTokens: 100, cachedInputTokens: 80, outputTokens: 5 });
});

test("missing usage is estimated only at completion and partial reported counts are retained", async () => {
  const records: UsageRecordInput[] = [];
  const content = "你好，this is the response.";
  const response = captureUsageResponse(Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 100 } }), context, (record) => records.push(record), undefined, { inputTokenEstimate: 999 });
  await response.text();
  assert.equal(records[0].finalized, false);
  assert.equal(records[0].usage, undefined);
  assert.equal(records.at(-1)!.finalized, true);
  assert.equal(records.at(-1)!.usage?.inputTokens, 100);
  assert.equal(records.at(-1)!.usage?.outputTokens, estimateTextTokens(content));
  assert.deepEqual(records.at(-1)!.estimation, { method: "content", inputEstimated: false, outputEstimated: true, tokenizer: "o200k_base", cacheUsageMissing: true });
  const actual: UsageRecordInput[] = [];
  await captureUsageResponse(Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 37 } }), context, (record) => actual.push(record), undefined, { inputTokenEstimate: 999 }).text();
  assert.equal(actual.at(-1)!.usage?.outputTokens, 37);
  assert.equal(actual.at(-1)!.estimation, undefined);
  const inconsistentCache: UsageRecordInput[] = [];
  await captureUsageResponse(Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 120 } } }), context, (record) => inconsistentCache.push(record), undefined, { inputTokenEstimate: 999 }).text();
  assert.equal(inconsistentCache.at(-1)!.usage?.inputTokens, 100, "fallback must not inflate the reported input count when cache details are inconsistent");
  assert.equal(inconsistentCache.at(-1)!.usage?.cachedInputTokens, 100);
  assert.equal(inconsistentCache.at(-1)!.estimation?.inputEstimated, false);
});

test("input tokenization is lazy and is skipped for reported input and rejected attempts", async () => {
  let estimates = 0;
  const options = { inputTokenEstimate: () => { estimates++; return 100; } };
  for (const response of [
    Response.json({ usage: { input_tokens: 10, output_tokens: 2 } }),
    Response.json({ usage: { input_tokens: 10 }, output_text: "Done." }),
    Response.json({ error: { message: "rejected" } }, { status: 429 })
  ]) await captureUsageResponse(response, context, () => {}, undefined, options).text();
  assert.equal(estimates, 0);
  await captureUsageResponse(Response.json({ output_text: "Done." }), context, () => {}, undefined, options).text();
  assert.equal(estimates, 1);
});

test("cache estimates use nearby real samples from the same provider and retain explicit provenance", (t) => {
  const { store, sql } = setup(t);
  store.savePrice({ providerId: "", model: "model", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 });
  const base = { ...context, createdAt: "2026-09-11T00:00:00.000Z", statusCode: 200 };
  for (const inputTokens of [90000, 100000, 110000]) store.record({ ...base, id: `real-${inputTokens}`, usage: { inputTokens, cachedInputTokens: inputTokens * 0.9, cacheWriteInputTokens: 0, outputTokens: 1000, totalTokens: inputTokens + 1000 } });
  const estimated: UsageRecordInput = { ...base, id: "estimated", usage: { inputTokens: 100000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, totalTokens: 100002 }, estimation: { method: "content", inputEstimated: true, outputEstimated: true, cacheUsageMissing: true } };
  store.record(estimated);
  const row = sql.prepare("SELECT cached_input_tokens, cost_nano, estimation_json FROM usage_records WHERE id='estimated'").get() as { cached_input_tokens: number; cost_nano: number; estimation_json: string };
  assert.equal(row.cached_input_tokens, 90000);
  assert.equal(row.cost_nano, 95060000, "cache uncertainty must not silently charge all input at the ordinary rate");
  assert.equal(JSON.parse(row.estimation_json).cacheSampleCount, 3);
  assert.equal(JSON.parse(row.estimation_json).cacheEstimated, true);
  assert.equal(store.report().totals.estimatedCachedInputTokens, 90000);
  store.record({ ...estimated, id: "different-provider", providerId: "other" });
  assert.equal(store.report().totals.unpricedRequests, 1);
  assert.equal(store.priceUnpricedRecords(), 0, "a price refresh cannot manufacture missing cache evidence");
  store.record({ ...estimated, estimation: undefined, usage: { ...estimated.usage!, cachedInputTokens: 50000 } });
  assert.equal(store.report().totals.estimatedCachedInputTokens, 0, "later reported usage replaces cache estimates");
});

test("historical backfill carries cache-read and write proportions without inflating total tokens", (t) => {
  const { store, sql } = setup(t);
  const base = { ...context, createdAt: "2026-09-11T00:00:00.000Z", statusCode: 200 };
  store.record({ ...base, id: "known", usage: { inputTokens: 1000, cachedInputTokens: 700, cacheWriteInputTokens: 200, cacheWriteLongInputTokens: 50, outputTokens: 100, totalTokens: 1100 } });
  store.record({ ...base, id: "missing", requestId: "other" });
  store.record({ ...base, id: "other-provider", providerId: "other" });
  assert.deepEqual(store.estimateMissingRecords(), { updated: 1, remaining: 1 });
  const row = sql.prepare("SELECT input_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_long_input_tokens FROM usage_records WHERE id='missing'").get();
  assert.deepEqual(row, { input_tokens: 1000, cached_input_tokens: 700, cache_write_input_tokens: 200, cache_write_long_input_tokens: 50 });
});

test("failed attempts keep observed generation estimates while rejected errors estimate zero", async () => {
  for (const partial of [false, true]) {
    const records: UsageRecordInput[] = [];
    const text = (partial ? frame({ type: "response.reasoning_summary_text.delta", delta: "observed reasoning" }) : "") + frame({ type: "error", error: { message: "overloaded" } });
    await captureUsageResponse(new Response(text), context, (record) => records.push(record), undefined, { inputTokenEstimate: 200 }).text();
    const final = records.at(-1)!;
    assert.equal(final.statusCode, 599);
    assert.equal(final.estimation?.method, partial ? "content" : "rejected");
    assert.equal(final.usage?.inputTokens, partial ? 200 : 0);
    assert.equal(final.usage?.outputTokens, partial ? estimateTextTokens("observed reasoning") : 0);
  }
  const records: UsageRecordInput[] = [];
  let calls = 0;
  const source = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++calls === 1) controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "partial answer" } }] })));
      else controller.error(new Error("connection terminated"));
    }
  }, { highWaterMark: 0 }));
  await assert.rejects(captureUsageResponse(source, context, (record) => records.push(record), undefined, { inputTokenEstimate: 200 }).text(), /connection terminated/);
  assert.equal(records.at(-1)!.statusCode, 599);
  assert.equal(records.at(-1)!.usage?.outputTokens, estimateTextTokens("partial answer"));
});

test("real usage replaces an estimate and its price, while later estimates cannot downgrade it", (t) => {
  const { store, sql } = setup(t);
  store.savePrice({ providerId: "", model: "model", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 1 });
  const row: UsageRecordInput = { ...context, id: "estimate", createdAt: "2026-09-09T00:00:00Z", statusCode: 200, finalized: false };
  store.record(row);
  assert.equal(store.report().totals.pendingRequests, 1);
  assert.equal(store.report().totals.missingUsageRequests, 0);
  const estimated = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 120 };
  store.record({ ...row, finalized: true, usage: estimated, estimation: { method: "content" } });
  assert.equal(store.report().totals.estimatedRequests, 1);
  assert.equal(store.report().totals.estimatedTotalTokens, 120);
  assert.equal(store.report().totals.estimatedUsageCostUsd, 0.00012);
  const markup = renderToStaticMarkup(createElement(UsageSummary, { totals: store.report().totals }));
  assert.match(markup, /含估算/); assert.match(markup, /上游实报 0 次/); assert.match(markup, /估算 1 次/); assert.match(markup, /120 Token/);
  const reported = { ...estimated, inputTokens: 80, cachedInputTokens: 40, outputTokens: 10, totalTokens: 90 };
  store.record({ ...row, finalized: true, usage: reported });
  store.record({ ...row, finalized: true, usage: estimated, estimation: { method: "historical" } });
  store.record(row);
  const totals = store.report().totals;
  assert.equal(totals.reportedRequests, 1); assert.equal(totals.estimatedRequests, 0); assert.equal(totals.pendingRequests, 0);
  assert.equal(totals.totalTokens, 90); assert.equal(totals.estimatedCostUsd, 0.00005);
  assert.equal((sql.prepare("SELECT estimation_json FROM usage_records").get() as { estimation_json: string | null }).estimation_json, null);
});

test("historical backfill respects filters, uses real references only, and keeps pending or unsupported records", (t) => {
  const { store, sql } = setup(t);
  const record = (id: string, client: string, input?: number, output?: number): UsageRecordInput => ({ ...context, id, requestId: id, apiKeyId: client, createdAt: `2026-09-09T00:${id === "known-a" ? "00" : "20"}:00Z`, statusCode: 200,
    ...(input === undefined ? {} : { usage: { inputTokens: input, outputTokens: output!, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: input + output! } }) });
  store.record(record("known-a", "a", 100, 20)); store.record(record("known-b", "a", 200, 40));
  store.record(record("unknown-a", "a"));
  store.record({ ...record("known-sibling", "b", 300, 50), requestId: "same-request" });
  store.record({ ...record("unknown-sibling", "b"), requestId: "same-request", createdAt: "2026-09-09T00:10:00Z" });
  store.record(record("unsupported", "c"));
  store.record({ ...record("pending", "a"), finalized: false });
  store.record({ ...record("rejected", "d"), statusCode: 403 });
  assert.deepEqual(store.estimateMissingRecords({ apiKeyId: "a" }), { updated: 1, remaining: 0 });
  const filled = sql.prepare("SELECT input_tokens, output_tokens, estimation_json FROM usage_records WHERE id='unknown-a'").get() as { input_tokens: number; output_tokens: number; estimation_json: string };
  assert.equal(filled.input_tokens, 150); assert.equal(filled.output_tokens, 30);
  assert.equal(JSON.parse(filled.estimation_json).method, "historical");
  assert.deepEqual(store.estimateMissingRecords(), { updated: 2, remaining: 1 });
  assert.deepEqual(store.estimateMissingRecords(), { updated: 0, remaining: 1 });
  const totals = store.report().totals;
  assert.equal(totals.reportedRequests, 3); assert.equal(totals.estimatedRequests, 3);
  assert.equal(totals.historicalEstimatedRequests, 2); assert.equal(totals.missingUsageRequests, 1); assert.equal(totals.pendingRequests, 1);
  assert.equal((sql.prepare("SELECT output_tokens FROM usage_records WHERE id='unknown-sibling'").get() as { output_tokens: number }).output_tokens, 0, "a failed earlier attempt must not inherit the successful retry's output");
  sql.prepare("DELETE FROM usage_records WHERE estimation_json IS NULL AND input_tokens IS NOT NULL").run();
  store.record(record("no-real-reference", "a"));
  assert.equal(store.estimateMissingRecords().updated, 0, "estimated history cannot become evidence for more estimates");
});

test("historical backfill processes more than one batch without letting unsupported rows block later records", (t) => {
  const { store } = setup(t);
  const base = { ...context, createdAt: "2026-09-09T00:00:00Z", statusCode: 200 };
  store.record({ ...base, id: "known", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 120 } });
  for (let i = 0; i < 1005; i++) store.record({ ...base, id: `row-${String(i).padStart(5, "0")}`, requestId: String(i), model: i % 2 ? "model" : "no-reference" });
  assert.deepEqual(store.estimateMissingRecords(), { updated: 502, remaining: 503 });
  assert.deepEqual(store.estimateMissingRecords(), { updated: 0, remaining: 503 });
});

test("interrupted records stop being pending after log recovery and active requests stay pending", (t) => {
  const { store, sql } = setup(t);
  sql.exec("CREATE TABLE request_logs (id TEXT PRIMARY KEY, data_json TEXT)");
  sql.prepare("INSERT INTO request_logs VALUES (?, ?)").run("live", JSON.stringify({ result: { status: "pending" } }));
  for (const id of ["live", "interrupted"]) store.record({ ...context, id, requestId: id, createdAt: "2026-09-09T00:00:00Z", statusCode: 200, finalized: false });
  store.recoverInterruptedRecords();
  assert.equal(store.report().totals.pendingRequests, 1);
  assert.equal(store.report().totals.missingUsageRequests, 1);
});
