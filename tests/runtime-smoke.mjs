// Run after pnpm build. All credentials, databases and upstream traffic are local fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonStore } from "../build/server/store/index.js";
import { officialPriceSources } from "../build/server/pricing-sources.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "samapi-runtime-smoke-"));
// Persist a future due time so this routing smoke test never contacts real price sources.
const fixtureStore = new JsonStore(dataDir);
for (const { id, name, url } of officialPriceSources) fixtureStore.saveModelPriceSyncState({
  id, name, url, status: "pending", modelCount: 0, nextSyncAt: new Date(Date.now() + 86400000).toISOString()
});
fixtureStore.close();
let transportRetryCalls = 0;
let streamRetryCalls = 0;
let grokCalls = 0;
const streamRetryFailures = 7;
const upstream = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.url?.endsWith("/responses")) {
    grokCalls++;
    assert.equal(request.headers.authorization, "Bearer fixture-grok-access");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_grok_fixture", object: "response", status: "completed", model: "grok-fixture", output: [{ id: "msg_grok_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture Grok reply", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }));
    return;
  }
  const message = body ? JSON.parse(body).messages?.at(-1)?.content : undefined;
  // Explicit cache usage lets estimated input/output counts be priced without historical samples.
  if (message === "runtime estimate stream") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"fixture estimated reply"}}]}\n\ndata: {"usage":{"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]\n\n');
    return;
  }
  if (message === "runtime estimate json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fixture estimated reply" } }], usage: { prompt_tokens_details: { cached_tokens: 0 } } }));
    return;
  }
  if (message === "runtime retry transport" && ++transportRetryCalls === 1) { response.destroy(); return; }
  if (message === "runtime retry stream") {
    // Match Codex/relay failures: metadata comes before an HTTP 200 SSE error, possibly without Content-Type.
    response.writeHead(200);
    response.write('event: codex.rate_limits\ndata: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":25}}}\n\nevent: codex.response.metadata\ndata: {"type":"codex.response.metadata","headers":{"x-request-id":"fixture-request"}}\n\n');
    if (++streamRetryCalls <= streamRetryFailures) {
      response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { output: [], instructions: "fixture instruction ".repeat(8000) } })}\n\n`);
      if (streamRetryCalls === 2) response.write('event: keepalive\ndata: {"type":"keepalive"}\n\nevent: keepalive\ndata: keepalive\n\n');
      if (streamRetryCalls === 3) response.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_empty"}}\n\nevent: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_empty","summary":null,"encrypted_content":"fixture opaque context"}}\n\n');
      if (streamRetryCalls >= 4) response.write('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"discarded reasoning"}\n\n');
      if (streamRetryCalls >= 5) response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"discarded answer"}\n\nevent: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"discarded_call","name":"discarded_action","arguments":"{}"}}\n\n');
      if (streamRetryCalls === 6) { response.end(); return; }
      if (streamRetryCalls === 7) { setTimeout(() => response.destroy(), 20); return; }
      response.end('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\nevent: error\ndata: {"error":{"message":"fixture overloaded"}}\n\n');
    } else {
      response.end('data: {"choices":[{"delta":{"content":"fixture recovered stream"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
    }
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(request.url?.endsWith("/models") ? { data: [{ id: "fixture-model" }] } : { choices: [{ message: { role: "assistant", content: "fixture reply" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
});
const reserve = http.createServer();
let child;
let output = "";
try {
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  child = spawn(process.execPath, ["build/server/index.js"], {
    env: { ...process.env, SAMAPI_DATA_DIR: dataDir, SAMAPI_PORT: String(port), SAMAPI_HOST: "127.0.0.1", SAMAPI_ADMIN_PASSWORD: "samapi-smoke-only", SAMAPI_ADMIN_COOKIE_SECURE: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited: ${output}`);
    try { ready = (await fetch(`${origin}/api/health`)).ok; } catch { /* startup */ }
    if (ready) break;
    await sleep(50);
  }
  assert.equal(ready, true, "compiled API must start");
  assert.match(await (await fetch(origin)).text(), /<div id="root"><\/div>/);
  assert.equal((await fetch(`${origin}/api/usage`)).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "samapi-smoke-only" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const api = async (pathname, method = "GET", payload) => {
    const response = await fetch(`${origin}${pathname}`, { method, headers: { cookie, "Content-Type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const value = await response.json(); assert.equal(response.ok, true, `${pathname}: ${JSON.stringify(value)}`); return value;
  };
  const site = await api("/api/sites", "POST", { name: "runtime-fixture", addresses: [{ label: "fixture", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, enabled: true, models: [] }] });
  await api("/api/provider-key-groups", "POST", { siteId: site.id, apiKeys: [{ label: "fixture", secret: "fixture-upstream", enabled: true, models: ["fixture-model"] }] });
  await api("/api/routes", "POST", { name: "fixture-route", type: "switch", siteId: site.id, model: "fixture-model", endpoint: "chat/completions", enabled: true });
  const client = await api("/api/keys", "POST", { name: "runtime-client" });
  await api("/api/usage/prices", "POST", { providerId: "", model: "fixture-model", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 8 });
  for (let i = 0; i < 2; i++) {
    const result = await fetch(`${origin}/proxy/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${client.plainTextKey}`, "X-Samapi-Project-Path": "/work/runtime", "X-Samapi-Project-Name": "runtime", "X-Samapi-Turn-Id": "runtime-turn", "X-Samapi-Session-Id": "runtime-session", "X-Request-Id": `runtime-request-${i}` }, body: JSON.stringify({ model: "fixture-route", messages: [{ role: "user", content: "old fixture turn" }, { role: "assistant", content: "old fixture reply" }, { role: "user", content: "shared fixture message" }] }) });
    assert.equal(result.status, 200); assert.equal((await result.json()).choices[0].message.content, "fixture reply");
  }
  const report = await api(`/api/usage?apiKeyId=${client.id}`);
  assert.equal(report.totals.totalTokens, 26); assert.equal(report.totals.requests, 2); assert.equal(report.totals.estimatedCostUsd, 0.000088);
  const page = await api("/api/logs");
  assert.equal(page.total, 1); assert.equal(page.items[0].requestCount, 2); assert.equal(page.items[0].phase, "returned");
  const detail = await api(`/api/logs/${page.items[0].id}`);
  assert.equal(detail.calls.length, 2); assert.equal(detail.calls[0].attempts.length, 1); assert.equal(detail.calls[1].attempts.length, 1);
  assert.deepEqual(detail.msg, ["shared fixture message"]); assert.equal(detail.requestHeaders.authorization, "***"); assert.equal(detail.result.body, "fixture reply");
  assert.equal(detail.requestHeaders["x-request-id"], "runtime-request-0");
  assert.ok(detail.calls.every((call) => !("requestHeaders" in call)));
  const modelsResponse = await fetch(`${origin}/proxy/v1/models`, { headers: { Authorization: `Bearer ${client.plainTextKey}`, "X-Samapi-Project-Path": "/work/runtime", "X-Samapi-Project-Name": "runtime", "X-Samapi-Turn-Id": "runtime-turn", "X-Samapi-Session-Id": "runtime-session" } });
  assert.equal(modelsResponse.status, 200);
  assert.ok((await modelsResponse.json()).data.some((model) => model.id === "fixture-route"));
  const modelsPage = await api("/api/logs");
  assert.equal(modelsPage.total, 2, "model polling must not merge into a conversation with matching headers");
  const modelsLog = modelsPage.items.find((item) => item.kind === "models");
  assert.ok(modelsLog); assert.equal(modelsLog.messageCount, 0); assert.equal(modelsLog.attemptCount, 0);
  const modelsDetail = await api(`/api/logs/${modelsLog.id}`);
  assert.equal(modelsDetail.kind, "models"); assert.deepEqual(modelsDetail.msg, []);
  assert.ok(JSON.parse(modelsDetail.result.body).models.includes("fixture-route"));
  assert.deepEqual(await api(`/api/logs/${detail.id}`), detail, "model polling must not replace a conversation's final result");
  await api("/api/logs/clear", "DELETE");
  assert.equal((await api("/api/usage")).totals.totalTokens, 26);
  assert.equal((await fetch(`${origin}/api/usage/openai/config`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${origin}/api/usage/openai`, { headers: { cookie } })).status, 404);
  assert.equal((await api("/api/usage/prices/sync")).sources.length, officialPriceSources.length);
  const firstAccount = await api("/api/accounts", "POST", { provider: "deepseek", label: "runtime-one", secret: "fixture-runtime-one", models: ["fixture-model"] });
  const secondAccount = await api("/api/accounts", "POST", { provider: "deepseek", label: "runtime-two", secret: "fixture-runtime-two", models: ["fixture-model"] });
  const accounts = await api("/api/accounts");
  assert.equal(JSON.stringify(accounts).includes("fixture-runtime-two"), false);
  const accountSiteId = accounts.providers.find((item) => item.provider === "deepseek").siteId;
  await api(`/api/sites/${accountSiteId}`, "PATCH", { name: "runtime-account-provider", addresses: [{ label: "fixture", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, enabled: true, models: [] }] });
  assert.equal((await api(`/api/accounts/${secondAccount.id}/check`, "POST")).available, 1);
  await api(`/api/accounts/${secondAccount.id}/prefer`, "POST");
  await api("/api/accounts/providers/deepseek/route", "POST", { name: "managed-fixture", model: "fixture-model" });
  const managedResponse = await fetch(`${origin}/proxy/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${client.plainTextKey}`, "X-Samapi-Project-Path": "/work/runtime", "X-Samapi-Project-Name": "runtime" }, body: JSON.stringify({ model: "managed-fixture", messages: [{ role: "user", content: "managed fixture message" }] }) });
  assert.equal(managedResponse.status, 200); assert.equal((await managedResponse.json()).choices[0].message.content, "fixture reply");
  assert.equal((await api("/api/usage")).totals.totalTokens, 39);
  await api(`/api/accounts/${firstAccount.id}`, "DELETE");
  assert.equal((await api("/api/accounts")).providers.find((item) => item.provider === "deepseek").accounts.length, 1);
  for (const stream of [false, true]) {
    await api("/api/settings", "PATCH", { upstreamRetryCodeCounts: [{ statusCode: 599, count: stream ? streamRetryFailures : 1 }] });
    const message = stream ? "runtime retry stream" : "runtime retry transport";
    const retried = await fetch(`${origin}/proxy/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${client.plainTextKey}`, "X-Samapi-Project-Path": "/work/runtime", "X-Samapi-Project-Name": "runtime" }, body: JSON.stringify({ model: "fixture-route", stream, messages: [{ role: "user", content: message }] }) });
    assert.equal(retried.status, 200);
    if (stream) assert.equal(streamRetryCalls, streamRetryFailures + 1, "no failed attempt may commit HTTP 200 headers before the successful retry");
    const text = await retried.text();
    assert.match(text, stream ? /fixture recovered stream/ : /fixture reply/);
    assert.doesNotMatch(text, /overloaded|fetch failed|discarded/);
    const summary = (await api("/api/logs")).items.find((item) => item.msg === message);
    assert.deepEqual((await api(`/api/logs/${summary.id}`)).calls[0].attempts.map((attempt) => attempt.result.statusCode), stream ? [...Array(streamRetryFailures).fill(599), 200] : [599, 200]);
  }
  assert.equal(transportRetryCalls, 2);
  assert.equal(streamRetryCalls, streamRetryFailures + 1);
  const beforeEstimates = (await api("/api/usage")).totals;
  // Use enough system text to exceed 1,000 actual BPE tokens across both requests.
  for (const stream of [false, true]) {
    const estimated = await fetch(`${origin}/proxy/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${client.plainTextKey}`, "X-Samapi-Project-Path": "/work/runtime", "X-Samapi-Project-Name": "runtime" }, body: JSON.stringify({ model: "fixture-route", stream, messages: [{ role: "system", content: "full context instruction ".repeat(200) }, { role: "user", content: stream ? "runtime estimate stream" : "runtime estimate json" }] }) });
    assert.equal(estimated.status, 200);
    assert.match(await estimated.text(), /fixture estimated reply/);
  }
  const afterEstimates = (await api("/api/usage")).totals;
  assert.equal(afterEstimates.requests, beforeEstimates.requests + 2);
  assert.equal(afterEstimates.estimatedRequests, beforeEstimates.estimatedRequests + 2);
  assert.equal(afterEstimates.reportedRequests, beforeEstimates.reportedRequests);
  assert.equal(afterEstimates.missingUsageRequests, beforeEstimates.missingUsageRequests);
  assert.equal(afterEstimates.pendingRequests, 0);
  assert.ok(afterEstimates.estimatedInputTokens > beforeEstimates.estimatedInputTokens + 1000, "estimates include full system context, not only the logged user message");
  assert.ok(afterEstimates.estimatedOutputTokens > beforeEstimates.estimatedOutputTokens);
  assert.ok(afterEstimates.estimatedUsageCostUsd > beforeEstimates.estimatedUsageCostUsd);
  assert.deepEqual(await api("/api/usage/estimate-missing", "POST"), { updated: 0, remaining: 0 });
  const grokImport = await api("/api/accounts/import", "POST", { providerType: "grok", models: ["grok-fixture"], content: JSON.stringify({ type: "xai", name: "runtime-grok", access_token: "fixture-grok-access", refresh_token: "fixture-grok-refresh", expired: "2099-01-01T00:00:00Z", base_url: `http://127.0.0.1:${upstream.address().port}/v1` }) });
  const grokId = grokImport.accountIds[0];
  assert.equal(grokImport.group.providerType, "grok");
  assert.equal(JSON.stringify(grokImport).includes("fixture-grok-access"), false);
  const grokState = (await api("/api/accounts")).providers.find((item) => item.provider === "grok");
  assert.equal(grokState.accounts[0].id, grokId); assert.equal(grokState.accounts[0].kind, "oauth");
  assert.equal((await api(`/api/accounts/${grokId}/check`, "POST")).available, 1);
  await api("/api/accounts/providers/grok", "PATCH", { strategy: "sequential" });
  await api("/api/accounts/providers/grok/route", "POST", { name: "managed-grok-fixture", model: "grok-fixture" });
  const grokResponse = await fetch(`${origin}/proxy/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${client.plainTextKey}`, "X-Samapi-Project-Path": "/work/runtime", "X-Samapi-Project-Name": "runtime" }, body: JSON.stringify({ model: "managed-grok-fixture", messages: [{ role: "user", content: "runtime Grok account" }] }) });
  assert.equal(grokResponse.status, 200);
  assert.match(await grokResponse.text(), /fixture Grok reply/);
  assert.equal(grokCalls, 2, "Grok checks and proxy calls must both reach the native OAuth upstream");
  const disabledGrok = await api(`/api/accounts/${grokId}`, "PATCH", { label: "runtime-grok-updated", enabled: false });
  assert.equal(disabledGrok.enabled, false); assert.equal(disabledGrok.label, "runtime-grok-updated");
  await api("/api/accounts/batch", "DELETE", { ids: [grokId] });
  assert.equal((await api("/api/accounts")).providers.find((item) => item.provider === "grok").accounts.length, 0);
  console.log("Compiled runtime smoke passed: auth, assets, routing, reported and estimated JSON/SSE usage, logs, unified Grok account import/check/routing/edit/delete, and complete 599 retries after metadata, reasoning, text, tool calls, truncated SSE and socket termination without Content-Type.");
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  await new Promise((resolve) => upstream.close(resolve));
  reserve.close();
  rmSync(dataDir, { recursive: true, force: true });
}
