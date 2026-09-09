import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ModelPriceSyncState, OfficialModelPrice, TokenUsage, UsageRecordInput } from "../shared/usage.js";
import { createModelPriceSync, nextModelPriceSyncAt } from "../server/model-price-sync.js";
import { officialPriceSources, parseAnthropicPrices, parseDeepSeekPrices, parseGooglePrices, parseKimiPrices, parseMinimaxPrices, parseMimoPrices, parseOpenAiPrices, parseQwenPrices, parseStepfunPrices, parseXaiPrices, parseZaiPrices } from "../server/pricing-sources.js";
import { JsonStore } from "../server/store/index.js";
import { usageCostNano } from "../server/store/usage.js";
import { createUsageCapture, requestCacheMode, usageFields } from "../server/usage-capture.js";

// Small extracts from the linked official documents, fetched on 2026-09-08.
// Tests use fixed published examples and never depend on live prices or the network.
const fixture = (file: string) => readFileSync(new URL(`./fixtures/model-pricing/${file}`, import.meta.url), "utf8");
const source = (id: string) => officialPriceSources.find((item) => item.id === id)!;
const priceOf = (prices: OfficialModelPrice[], model: string) => {
  const price = prices.find((item) => item.model === model);
  assert.ok(price, `${model} must have an official price`);
  return price;
};
const usage = (inputTokens = 1000000, outputTokens = 0, cachedInputTokens = 0): TokenUsage => ({ inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens: 0, totalTokens: inputTokens + outputTokens });
const testSource = { id: "fixture", name: "Fixture", url: "https://example.com/pricing" };
const official = (model = "fixture-model", inputUsdPerMillion = 2): OfficialModelPrice => ({ providerId: "", model, inputUsdPerMillion, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 8, source: testSource });
const syncedState = (id = "fixture"): ModelPriceSyncState => ({ ...testSource, id, status: "success", modelCount: 1, lastSuccessAt: "2026-09-08T00:00:00.000Z", nextSyncAt: "2026-09-09T00:00:00.000Z" });
const ledger = (t: TestContext) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-official-prices-"));
  const store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
};
const record = (id: string, model = "fixture-model"): UsageRecordInput => ({ id, model, requestId: id, apiKeyId: "client", apiKeyName: "Client", providerId: "p", providerName: "P", statusCode: 200, createdAt: "2026-09-08T00:00:00.000Z", usage: usage() });

test("OpenAI uses standard pricing rather than batch, and applies long-context rates above the exact threshold", () => {
  const prices = parseOpenAiPrices(fixture("openai.html"), JSON.parse(fixture("openai-models.json")), source("openai"));
  const gpt = priceOf(prices, "gpt-5.5");
  assert.equal(gpt.inputUsdPerMillion, 5);
  assert.equal(gpt.cachedInputUsdPerMillion, 0.5);
  assert.equal(gpt.outputUsdPerMillion, 30);
  assert.equal(usageCostNano(usage(272000, 100), gpt), 1363000000n);
  assert.equal(usageCostNano(usage(272001, 100), gpt), 2724510000n);
  const astra = priceOf(prices, "gpt-6-astra");
  assert.equal(astra.rules?.[0].aboveInputTokens, 272000);
  assert.equal(astra.rules?.[0].inputUsdPerMillion, 20);
  assert.equal(astra.rules?.[0].cacheWriteUsdPerMillion, 25);
  assert.ok(priceOf(prices, "gpt-5.3-codex"));
  const pro = priceOf(prices, "gpt-5.5-pro");
  assert.equal(usageCostNano(usage(272001), pro), null, "unconfirmed long-context rates are never extrapolated");
  assert.equal(usageCostNano(usage(100, 0, 50), pro), null, "missing cache prices are not zero prices");
  assert.throws(() => parseOpenAiPrices("<html>layout changed</html>", {}, source("openai")));
});

test("Claude parses five-minute and one-hour cache writes and normalizes mixed cache usage", () => {
  const prices = parseAnthropicPrices(fixture("anthropic.md"), source("anthropic"));
  const opus = priceOf(prices, "claude-opus-4-8");
  assert.equal(opus.cacheWriteUsdPerMillion, 6.25);
  assert.equal(opus.cacheWriteLongUsdPerMillion, 10);
  const payload = { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } };
  const capture = createUsageCapture();
  capture.push(JSON.stringify({ usage: payload }));
  assert.deepEqual(capture.result(), { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 30, cacheWriteLongInputTokens: 20, outputTokens: 10, totalTokens: 110 });
  assert.equal(usageCostNano(capture.result()!, opus), 772500n);
  assert.equal(usageCostNano(capture.result()!, { ...opus, cacheWriteLongUsdPerMillion: undefined }), null);
  assert.equal(priceOf(prices, "claude-3-5-haiku").inputUsdPerMillion, 0.8);
});

test("DeepSeek prices follow UTC weekday windows at each boundary", () => {
  const flash = priceOf(parseDeepSeekPrices(fixture("deepseek.html"), source("deepseek")), "deepseek-v4-flash");
  assert.equal(flash.cachedInputUsdPerMillion, 0.007);
  for (const [at, expected] of [
    ["2026-09-08T00:59:59.999Z", 220000000n], ["2026-09-08T01:00:00Z", 440000000n],
    ["2026-09-08T04:00:00Z", 220000000n], ["2026-09-08T06:00:00Z", 440000000n],
    ["2026-09-08T10:00:00Z", 220000000n], ["2026-09-12T02:00:00Z", 220000000n],
    ["2026-09-08T09:00:00+08:00", 440000000n]
  ] as const) assert.equal(usageCostNano(usage(), flash, at), expected, at);
});

test("Gemini and GLM preserve announced future prices and ignore free, batch and struck-through rates", () => {
  const google = parseGooglePrices(fixture("google.html"), source("google"));
  const flash = priceOf(google, "gemini-3.8-flash");
  assert.equal(usageCostNano(usage(), flash, "2026-12-31T23:59:59Z"), 750000000n);
  assert.equal(usageCostNano(usage(), flash, "2027-01-01T00:00:00Z"), 1500000000n);
  const pro = priceOf(google, "gemini-2.5-pro");
  assert.equal(usageCostNano(usage(200000), pro), 250000000n);
  assert.equal(usageCostNano(usage(200001), pro), 500002500n);
  const noCache = priceOf(google, "gemini-2.5-computer-use-preview-10-2025");
  assert.equal(usageCostNano(usage(300000, 0, 100), noCache), null);
  const glm = priceOf(parseZaiPrices(fixture("zai.md"), source("zai")), "glm-5.3-flash");
  assert.equal(usageCostNano(usage(), glm, "2026-09-09T15:59:59Z"), 75000000n);
  assert.equal(usageCostNano(usage(), glm, "2026-09-09T16:00:00Z"), 150000000n);
});

test("xAI reads JSON price units and official aliases without executing downloaded JavaScript", () => {
  const prices = parseXaiPrices(fixture("xai.html"), source("xai"));
  const grok = priceOf(prices, "grok-4.20-0309-reasoning");
  assert.equal(grok.inputUsdPerMillion, 1.25);
  assert.equal(grok.outputUsdPerMillion, 2.5);
  assert.equal(grok.rules?.[0].aboveInputTokens, 200000);
  assert.equal(grok.rules?.[0].inputUsdPerMillion, 2.5);
  assert.equal(priceOf(prices, "grok-4.20").cachedInputUsdPerMillion, 0.2);
  assert.throws(() => parseXaiPrices('<script>globalThis.__XAI_PUBLIC_MODELS__=(()=>{throw Error("must not execute")})()</script>', source("xai")), SyntaxError);
});

test("MiniMax, Kimi, MiMo and StepFun use their current official standard USD rates", () => {
  const minimax = parseMinimaxPrices(fixture("minimax.md"), source("minimax"));
  const m3 = priceOf(minimax, "minimax-m3");
  assert.equal(m3.inputUsdPerMillion, 0.3);
  assert.equal(m3.outputUsdPerMillion, 1.2);
  assert.equal(m3.rules?.[0].aboveInputTokens, 512000);
  assert.equal(m3.rules?.[0].inputUsdPerMillion, 0.6);
  assert.equal(priceOf(minimax, "minimax-m2.7").cacheWriteUsdPerMillion, 0.375);
  const kimi = priceOf(parseKimiPrices(fixture("kimi.md"), source("kimi")), "kimi-k2.6");
  assert.equal(kimi.inputUsdPerMillion, 0.95);
  assert.equal(kimi.cachedInputUsdPerMillion, 0.16);
  const mimo = priceOf(parseMimoPrices(fixture("mimo.md"), source("xiaomi")), "mimo-v2.5-pro");
  assert.equal(mimo.inputUsdPerMillion, 0.435);
  assert.equal(mimo.cachedInputUsdPerMillion, 0.0036);
  assert.equal(mimo.cacheWriteUsdPerMillion, 0);
  const step = parseStepfunPrices(fixture("stepfun.md"), source("stepfun"));
  assert.equal(step.length, 3);
  assert.equal(priceOf(step, "step-3.5-flash").inputUsdPerMillion, 0.1);
  assert.equal(priceOf(step, "step-3.7-flash").outputUsdPerMillion, 1.15);
});

test("Qwen selects international prices, expands table spans and distinguishes explicit from implicit caching", () => {
  const prices = parseQwenPrices(fixture("qwen.html"), source("qwen"), fixture("qwen-cache.html"));
  const qwen = priceOf(prices, "qwen3.7-max");
  assert.equal(qwen.inputUsdPerMillion, 2.5);
  assert.equal(qwen.outputUsdPerMillion, 7.5);
  assert.equal(usageCostNano(usage(1000, 0, 1000), qwen, undefined, "implicit"), 500000n);
  assert.equal(usageCostNano(usage(1000, 0, 1000), qwen, undefined, "explicit"), 250000n);
  assert.equal(usageCostNano(usage(1000, 0, 1000), qwen), null);
  const plus = priceOf(prices, "qwen3.6-plus");
  assert.equal(plus.rules?.[0].aboveInputTokens, 256000);
  assert.equal(plus.rules?.[0].inputUsdPerMillion, 2);
  assert.equal(usageCostNano(usage(300000, 0, 100000), plus, undefined, "explicit"), 420000000n);
  assert.equal(usageCostNano(usage(1000001), plus), null);
  assert.equal(prices.some((price) => price.model === "qwen-plus"), false, "ambiguous thinking-mode prices must stay unpriced");
  const latest = priceOf(prices, "qwen3.8-max");
  assert.equal(usageCostNano(usage(1000, 0, 1000), latest, undefined, "implicit"), null, "console-only cache exceptions are not assumed to be the usual discount");
  assert.deepEqual(usageFields({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20, cache_creation_input_tokens: 30 } }), { inputTokens: 100, outputTokens: 5, cachedInputTokens: 20, cacheWriteInputTokens: 30 });
  assert.equal(requestCacheMode({ messages: [{ content: [{ type: "text", text: "shared prefix", cache_control: { type: "ephemeral" } }] }] }), "explicit");
  assert.equal(requestCacheMode({ messages: [{ content: '{"cache_control":{"type":"ephemeral"}}' }] }), "implicit");
});

test("official source loaders discover only official Kimi pages and validate all saved fixture prices", async (t) => {
  const store = ledger(t);
  const files: Record<string, string> = { openai: "openai.html", anthropic: "anthropic.md", google: "google.html", deepseek: "deepseek.html", xai: "xai.html", zai: "zai.md", minimax: "minimax.md", qwen: "qwen.html", xiaomi: "mimo.md", stepfun: "stepfun.md" };
  const docs: Record<string, string> = JSON.parse(fixture("openai-models.json"));
  const sync = createModelPriceSync(store, { now: () => new Date("2026-09-08T12:00:00Z"), fetchText: async (url) => {
    if (url.startsWith("https://developers.openai.com/api/docs/models/")) return docs[url.split("/").at(-1)!] || "";
    if (url.endsWith("/model-studio/context-cache")) return fixture("qwen-cache.html");
    if (url === source("kimi").url) return '<a href="/docs/pricing/chat-k26">Kimi</a><a href="https://example.com/docs/pricing/chat-fake">Ignore</a>';
    if (url === "https://platform.kimi.ai/docs/pricing/chat-k26.md") return fixture("kimi.md");
    const item = officialPriceSources.find((source) => source.url === url);
    assert.ok(item && files[item.id], `unexpected official URL ${url}`);
    return fixture(files[item.id]);
  } });
  const report = await sync.sync();
  assert.equal(report.running, false);
  assert.deepEqual(report.sources.filter((source) => source.status !== "success"), []);
  assert.ok(store.listModelPrices().length > 70);
});

test("daily schedule uses Beijing 08:00, catches up at startup, avoids overlaps and stops cleanly", async (t) => {
  assert.equal(nextModelPriceSyncAt(new Date("2026-09-08T23:59:59Z")).toISOString(), "2026-09-09T00:00:00.000Z");
  assert.equal(nextModelPriceSyncAt(new Date("2026-09-09T00:00:00Z")).toISOString(), "2026-09-10T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-09-08T20:00:00Z") });
  const store = ledger(t);
  let calls = 0;
  const sync = createModelPriceSync(store, { sources: [{ ...testSource, read: async () => { calls++; return [official()]; } }] });
  t.after(() => sync.stop());
  sync.start();
  assert.equal(calls, 0);
  t.mock.timers.tick(1000);
  await sync.sync(false);
  assert.equal(calls, 1);
  await sync.sync(false);
  assert.equal(calls, 1);
  t.mock.timers.tick(Date.parse("2026-09-09T00:00:00Z") - Date.now());
  await sync.sync(false);
  assert.equal(calls, 2);
  sync.stop();
  t.mock.timers.tick(86400000);
  assert.equal(calls, 2);
});

test("failed or invalid sources retain prices, retry hourly and preserve due times across scheduler restarts", async (t) => {
  const store = ledger(t);
  store.saveOfficialModelPrices([official()], syncedState());
  const original = store.listModelPrices();
  let at = new Date("2026-09-08T12:00:00Z");
  let calls = 0;
  let next: OfficialModelPrice[] | Error = new Error("HTTP 503");
  const options = { now: () => at, sources: [{ ...testSource, async read() { calls++; if (next instanceof Error) throw next; return next; } }] };
  let sync = createModelPriceSync(store, options);
  await sync.sync();
  assert.deepEqual(store.listModelPrices(), original);
  assert.equal(sync.status().sources[0].nextSyncAt, "2026-09-08T13:00:00.000Z");
  assert.equal(sync.status().sources[0].lastSuccessAt, syncedState().lastSuccessAt);
  sync = createModelPriceSync(store, options);
  at = new Date("2026-09-08T12:59:59Z");
  await sync.sync(false);
  assert.equal(calls, 1);
  at = new Date("2026-09-08T13:00:00Z");
  next = [official("fixture-model", 3)];
  await sync.sync(false);
  assert.equal(calls, 2);
  assert.equal(store.listModelPrices()[0].inputUsdPerMillion, 3);
  for (const invalid of [[], [official("new"), official("fixture-model", NaN)], [{ ...official(), rules: [{ ...official(), aboveInputTokens: -1 }] }], [{ ...official(), rules: [{ ...official(), effectiveFrom: "bad-date" }] }]]) {
    const before = store.listModelPrices();
    next = invalid;
    await sync.sync();
    assert.equal(sync.status().sources[0].status, "failed");
    assert.deepEqual(store.listModelPrices(), before, "a partially invalid catalog is rejected atomically");
  }
});

test("concurrent scheduled and manual refreshes share one run with at most three sources in flight", async (t) => {
  const store = ledger(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0, maxActive = 0, calls = 0;
  const sources = Array.from({ length: 5 }, (_, index) => ({ ...testSource, id: `fixture-${index}`, async read() {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await gate;
    active--;
    return [{ ...official(`model-${index}`), source: { ...testSource, id: this.id } }];
  } }));
  const sync = createModelPriceSync(store, { sources });
  const first = sync.sync(false);
  assert.equal(sync.sync(), first);
  assert.equal(sync.status().running, true);
  assert.equal(active, 3);
  release();
  await first;
  assert.equal(calls, 5);
  assert.equal(maxActive, 3);
  assert.equal(sync.status().running, false);
});

test("manual prices win over official updates and omitted models keep their last known rate", (t) => {
  const store = ledger(t);
  store.saveOfficialModelPrices([official(), official("older-model")], syncedState());
  store.saveModelPrice({ ...official(), inputUsdPerMillion: 7 });
  store.saveOfficialModelPrices([official("fixture-model", 9)], syncedState());
  assert.equal(store.listModelPrices().find((price) => price.model === "fixture-model")?.source, undefined);
  assert.ok(store.listModelPrices().some((price) => price.model === "older-model"));
  store.recordUsage(record("manual", "FIXTURE-MODEL"));
  assert.equal(store.usageReport().totals.estimatedCostUsd, 7);
  store.saveModelPrice({ ...official(), providerId: "p", inputUsdPerMillion: 1 });
  store.recordUsage(record("provider"));
  assert.equal(store.usageReport().totals.estimatedCostUsd, 8);
});

test("ledger snapshots original rules and timestamps across daily updates, delayed responses and backfills", (t) => {
  const store = ledger(t);
  const flash = priceOf(parseDeepSeekPrices(fixture("deepseek.html"), source("deepseek")), "deepseek-v4-flash");
  const state = { ...syncedState("deepseek"), ...source("deepseek") };
  store.saveOfficialModelPrices([flash], state);
  const pending = { ...record("delayed", "DeepSeek-AI/DeepSeek-V4-Flash"), createdAt: "2026-09-08T00:59:00.000Z", usage: undefined };
  store.recordUsage(pending);
  store.saveOfficialModelPrices([{ ...flash, inputUsdPerMillion: 9, rules: [] }], state);
  store.recordUsage({ ...pending, usage: usage(), createdAt: "2026-09-08T01:01:00.000Z" });
  assert.equal(store.usageReport().totals.estimatedCostUsd, 0.22);
  store.recordUsage({ ...record("backfill", "unpriced"), createdAt: "2026-09-08T02:00:00.000Z" });
  store.saveOfficialModelPrices([{ ...flash, model: "unpriced" }], state);
  assert.equal(store.priceUnpricedUsage(), 1);
  assert.equal(store.usageReport().totals.estimatedCostUsd, 0.66);
  assert.equal(store.priceUnpricedUsage(), 0);
  store.recordUsage(record("unknown-alias", "deepseek-v4-flash-think"));
  assert.equal(store.usageReport().totals.unpricedRequests, 1, "reseller suffixes are not guessed");
});
