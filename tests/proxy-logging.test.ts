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
import { CODEX_BACKEND_RESPONSES_URL, CODEX_USER_AGENT } from "../server/providers/constants.js";
import type { DownstreamModelRule, RequestLogStage } from "../shared/types.js";

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
  const request = async (body: unknown, onResponse?: (response: ResponseRecorder) => void, extraHeaders: Record<string, string> = {}, pathname = "/proxy/v1/chat/completions", includeProjectHeaders = true) => {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), {
      headers: {
        authorization: `Bearer ${key.plainTextKey}`, "content-type": "application/json", "user-agent": "fixture-client", "upstream-custom": "keep-me",
        ...(includeProjectHeaders ? { "x-samapi-project-path": "/work/fixture", "x-samapi-project-name": "fixture" } : {}), ...extraHeaders
      },
      method: "POST", url: pathname, socket: { remoteAddress: "127.0.0.1" }
    }) as unknown as http.IncomingMessage;
    const res = new ResponseRecorder();
    onResponse?.(res);
    await handler.handleProxy(req, res as unknown as http.ServerResponse, new URL(`http://localhost${pathname}`));
    return res;
  };
  return { store, sql, request, handler, key, site };
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

async function waitForRetryDelay(store: JsonStore, attempts: number) {
  const waiting = () => {
    const log = store.listRequestLogs()[0];
    return log?.result.stage === "waiting-retry" && log.attemptCount === attempts;
  };
  for (let turn = 0; turn < 40 && !waiting(); turn++) await nextTick();
  assert.equal(waiting(), true, "a retry must wait after the failed attempt, without delaying the first request");
}

function setupModelMapping(t: TestContext) {
  const fixture = setup(t);
  const { store, site } = fixture;
  const group = store.getDb().providerApiKeyGroups.find((group) => group.siteId === site.id)!;
  store.upsertProviderApiKeyGroup({ ...group, apiKeys: group.apiKeys.map((key) => ({ ...key, models: ["fixture-model", "upstream-cli", "upstream-app"] })) });
  const fallback = store.upsertRoute({ ...store.getDb().routes.find((route) => route.name === "alias")!, endpoint: "responses" });
  const cli = store.upsertRoute({ type: "switch", name: "cli-target", siteId: site.id, model: "upstream-cli", endpoint: "responses", enabled: true });
  const app = store.upsertRoute({ type: "switch", name: "app-target", siteId: site.id, model: "upstream-app", endpoint: "responses", enabled: true });
  const sent: Array<{ model: string; headers: Headers }> = [];
  globalThis.fetch = async (_target, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ model: body.model, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({
      id: `resp-mapped-${sent.length}`, object: "response", model: body.model, status: "completed",
      output: [{ id: "message", type: "message", role: "assistant", content: [{ type: "output_text", text: "mapped response" }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    }), { headers: { "content-type": "application/json" } });
  };
  const mapping = (id: string, targetRouteId: string, conditions: DownstreamModelRule["conditions"], model = "alias"): DownstreamModelRule => ({
    id, name: id, enabled: true, model, targetRouteId, conditions
  });
  return { ...fixture, fallback, cli, app, sent, mapping };
}

test("the same key and requested Responses model route CLI and App to different models using original headers", async (t) => {
  const { store, request, sql, key, cli, app, sent, mapping } = setupModelMapping(t);
  const template = store.upsertHeaderTemplate({ name: "upstream headers", headersText: "Originator: upstream-template\nUser-Agent: upstream-client" });
  store.upsertRoute({ ...app, headerTemplateId: template.id });
  store.updateApiKey(key.id, { models: ["gpt-5.6-sol"] });
  store.updateSettings({ downstreamModelRules: [
    mapping("cli", cli.id, [{ source: "header", header: "originator", match: "exact", value: "codex_cli_rs" }], "gpt-5.6-sol"),
    mapping("app", app.id, [{ source: "header", header: "originator", match: "exact", value: "Codex Desktop" }], "gpt-5.6-sol"),
    mapping("no recursive mapping", cli.id, [{ source: "header", header: "originator", match: "exact", value: "Codex Desktop" }], app.name)
  ] });
  for (const originator of ["codex_cli_rs", "Codex Desktop"]) {
    const response = await request({ model: "gpt-5.6-sol", input: "map this request" }, undefined, { originator }, "/proxy/v1/responses");
    assert.equal(response.statusCode, 200, response.text());
  }
  assert.deepEqual(sent.map((request) => request.model), ["upstream-cli", "upstream-app"]);
  assert.equal(sent[1].headers.get("originator"), "upstream-template");
  assert.deepEqual(new Set(store.listRequestLogs().map((log) => log.upstream?.model)), new Set(["upstream-cli", "upstream-app"]));
  assert.deepEqual(sql.prepare("SELECT DISTINCT model FROM usage_records ORDER BY model").all(), [{ model: "upstream-app" }, { model: "upstream-cli" }]);
});

test("direct model mappings apply their own request-header template", async (t) => {
  const { store, request, app, sent } = setupModelMapping(t);
  const template = store.upsertHeaderTemplate({ name: "direct App headers", headersText: "Originator: direct-template\nUser-Agent: direct-client" });
  store.updateSettings({ downstreamModelRules: [{
    id: "direct", name: "direct", enabled: true, model: "alias",
    targetSiteId: app.siteId, targetModel: "upstream-app", headerTemplateId: template.id, conditions: []
  }] });
  const response = await request({ model: "alias", input: "use direct template" }, undefined, { originator: "downstream-client" }, "/proxy/v1/responses");
  assert.equal(response.statusCode, 200, response.text());
  assert.equal(sent[0].model, "upstream-app");
  assert.equal(sent[0].headers.get("originator"), "direct-template");
  assert.equal(sent[0].headers.get("user-agent"), "direct-client");
});

test("project rules distinguish two projects in one App and fall back by client without carrying project state across requests", async (t) => {
  const { store, request, fallback, cli, app, sent, mapping } = setupModelMapping(t);
  const desktop = { source: "header", header: "originator", match: "exact", value: "Codex Desktop" } as const;
  store.updateSettings({ downstreamModelRules: [
    mapping("project A", app.id, [desktop, { source: "project", match: "prefix", value: "/work/project-a" }]),
    mapping("project B", cli.id, [desktop, { source: "project", match: "exact", value: "project-b" }]),
    mapping("App default", fallback.id, [desktop])
  ] });
  for (const [index, headers] of ([
    { "x-codex-turn-metadata": JSON.stringify({ workspaces: { "/work/project-a/subdir": {} } }) },
    { "x-samapi-project": "project-b", "x-codex-turn-metadata": JSON.stringify({ workspaces: { "/work/project-a": {} } }) },
    { "x-codex-turn-metadata": JSON.stringify({ workspaces: { "/work/project-a-other": {} } }) },
    { "x-codex-turn-metadata": "malformed" },
    {}
  ] as Record<string, string>[]).entries()) {
    const response = await request({ model: "alias", input: "same App and model" }, undefined, { originator: "Codex Desktop", ...headers }, "/proxy/v1/responses", index >= 3);
    assert.equal(response.statusCode, 200, response.text());
  }
  assert.deepEqual(sent.map((request) => request.model), ["upstream-app", "upstream-cli", "fixture-model", "fixture-model", "fixture-model"]);
});

test("unconditional model mappings retain original model permissions", async (t) => {
  const { store, request, key, app, sent, mapping } = setupModelMapping(t);
  store.updateSettings({ downstreamModelRules: [mapping("default", app.id, [], "gpt-5.6-sol")] });
  store.updateApiKey(key.id, { models: ["gpt-5.6-sol"] });
  const response = await request({ model: "gpt-5.6-sol", input: "no optional metadata" }, undefined, {}, "/proxy/v1/responses");
  assert.equal(response.statusCode, 200, response.text());
  assert.deepEqual(sent.map((request) => request.model), ["upstream-app"]);
  store.updateApiKey(key.id, { models: [app.name] });
  const denied = await request({ model: "gpt-5.6-sol", input: "not allowed" }, undefined, {}, "/proxy/v1/responses");
  assert.match(denied.text(), /不允许使用模型 gpt-5.6-sol/);
  assert.equal(sent.length, 1);
});

test("path and name headers select projects, stay in downstream logs and never reach the upstream", async (t) => {
  const { store, request, fallback, cli, app, sent, mapping } = setupModelMapping(t);
  const template = store.upsertHeaderTemplate({ name: "same client", headersText: `User-Agent: ${CODEX_USER_AGENT}` });
  for (const route of [fallback, cli, app]) store.upsertRoute({ ...route, headerTemplateId: template.id });
  store.updateSettings({ downstreamModelRules: [
    mapping("project A", app.id, [
      { source: "project", match: "prefix", value: "/work/project-a" },
      { source: "header", header: "x-samapi-project-name", match: "exact", value: "App" }
    ]),
    mapping("project B", cli.id, [{ source: "header", header: "x-samapi-project-name", match: "exact", value: "project-b" }])
  ] });
  const requests = [
    { "x-samapi-project-path": "/work/project-a/src", "x-samapi-project-name": "App", "x-samapi-project": "legacy-other" },
    { "x-samapi-project-path": "/work/project-b", "x-samapi-project-name": "project-b" },
    { "x-samapi-project-path": "/work/project-a-other", "x-samapi-project-name": "App" },
    {}
  ] as Record<string, string>[];
  for (const [index, headers] of requests.entries()) {
    const response = await request({ model: "alias", input: `project request ${index}` }, undefined, { "user-agent": CODEX_USER_AGENT, ...headers }, "/proxy/v1/responses");
    assert.equal(response.statusCode, 200, response.text());
    const log = store.getRequestLog(store.listRequestLogs()[0].id)!;
    for (const name of ["x-samapi-project-path", "x-samapi-project-name", "x-samapi-project"]) {
      assert.equal(sent[index].headers.get(name), null);
      assert.equal(log.requestHeaders?.[name], headers[name] ?? (name === "x-samapi-project-path" ? "/work/fixture" : name === "x-samapi-project-name" ? "fixture" : undefined));
    }
    assert.equal(sent[index].headers.get("upstream-custom"), "keep-me", "same-client passthrough must actually be exercised");
    assert.equal(sent[index].headers.get("authorization"), "Bearer fixture-upstream-key");
  }
  assert.deepEqual(sent.map((request) => request.model), ["upstream-app", "upstream-cli", "fixture-model", "fixture-model"]);
});

test("Codex workspace metadata materializes both project headers in logs while requests without a project use ordinary routing", async (t) => {
  const { store, request, app, sent, mapping } = setupModelMapping(t);
  store.updateSettings({ downstreamModelRules: [mapping("Codex project", app.id, [
    { source: "project", match: "exact", value: "/work/project-a" },
    { source: "header", header: "x-samapi-project-name", match: "exact", value: "project-a" }
  ])] });

  const metadata = JSON.stringify({ workspaces: { "/work/project-a": {} } });
  const derived = await request({ model: "alias", input: "derive project headers" }, undefined, {
    "x-codex-turn-metadata": metadata
  }, "/proxy/v1/responses", false);
  assert.equal(derived.statusCode, 200, derived.text());
  assert.equal(sent[0].model, "upstream-app");
  const derivedLog = store.getRequestLog(store.listRequestLogs()[0].id)!;
  assert.equal(derivedLog.requestHeaders["x-samapi-project-path"], "/work/project-a");
  assert.equal(derivedLog.requestHeaders["x-samapi-project-name"], "project-a");
  assert.equal(sent[0].headers.get("x-samapi-project-path"), null);
  assert.equal(sent[0].headers.get("x-samapi-project-name"), null);

  const missing = await request({ model: "alias", input: "missing project headers" }, undefined, {}, "/proxy/v1/responses", false);
  assert.equal(missing.statusCode, 200, missing.text());
  assert.equal(sent.length, 2);
  const missingLog = store.getRequestLog(store.listRequestLogs()[0].id)!;
  assert.equal(missingLog.requestHeaders["x-samapi-project-path"], undefined);
  assert.equal(missingLog.requestHeaders["x-samapi-project-name"], undefined);
});

test("project headers are removed on every upstream retry for both templates and passthrough, including Codex", async (t) => {
  for (const codex of [false, true]) for (const passthrough of [false, true]) {
    await t.test(`${codex ? "Codex" : "site"} ${passthrough ? "passthrough" : "template"}`, async (t) => {
      const { store, request } = setup(t);
      mockRetryTimers(t);
      if (codex) store.saveCodexOAuthAccount({ accessToken: "fixture-project-access", refreshToken: "fixture-project-refresh", accountId: "fixture-project-account" });
      const route = codex
        ? store.createManagedAccountRoute("gpt", { name: "project-retry", model: "gpt-fixture" })
        : store.getDb().routes.find((route) => route.name === "alias")!;
      const template = store.upsertHeaderTemplate({ name: "project retry headers", headersText: [
        `User-Agent: ${passthrough ? CODEX_USER_AGENT : "upstream-only"}`,
        "X-Samapi-Project-Path: /template/private", "x-samapi-project-path: /template/duplicate",
        "X-Samapi-Project-Name: template-private", "X-SAMAPI-PROJECT-NAME: duplicate",
        "X-Samapi-Project: legacy-private", "X-Upstream-Custom: template-kept"
      ].join("\n") });
      store.upsertRoute({ ...route, headerTemplateId: template.id });
      store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 503, count: 1 }] });
      let calls = 0;
      globalThis.fetch = async (_target, init) => {
        calls++;
        const headers = new Headers(init?.headers);
        for (const name of ["x-samapi-project-path", "x-samapi-project-name", "x-samapi-project"]) assert.equal(headers.get(name), null);
        assert.equal(headers.get(passthrough ? "upstream-custom" : "x-upstream-custom"), passthrough ? "keep-me" : "template-kept");
        if (calls === 1) return Response.json({ error: { message: "retry fixture" } }, { status: 503 });
        if (!codex) return Response.json({ choices: [{ message: { role: "assistant", content: "recovered" } }] });
        const response = { id: "resp-project", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }] };
        return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      };
      const result = await finishWithRetryTimers(t, request({ model: route.name, messages: [{ role: "user", content: "project retry" }] }, undefined, {
        "user-agent": CODEX_USER_AGENT, "x-samapi-project-path": "/client/private", "x-samapi-project-name": "client-private", "x-samapi-project": "legacy"
      }));
      assert.equal(result.statusCode, 200, result.text());
      assert.equal(calls, 2);
    });
  }
});

test("mapping keeps original model permissions and authentication, and disabled rules preserve ordinary routing", async (t) => {
  const { store, request, key, app, sent, mapping } = setupModelMapping(t);
  const rule = mapping("App", app.id, [{ source: "header", header: "originator", match: "exact", value: "Codex Desktop" }]);
  store.updateSettings({ downstreamModelRules: [rule] });
  store.updateApiKey(key.id, { models: [app.name] });
  const denied = await request({ model: "alias", input: "denied" }, undefined, { originator: "Codex Desktop" }, "/proxy/v1/responses");
  assert.match(denied.text(), /不允许使用模型 alias/);
  const unauthenticated = await request({ model: "alias", input: "invalid key" }, undefined, { authorization: "Bearer invalid", originator: "Codex Desktop" }, "/proxy/v1/responses");
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(sent.length, 0);
  store.updateApiKey(key.id, { models: ["alias"] });
  store.updateSettings({ downstreamModelRules: [{ ...rule, enabled: false }] });
  assert.equal((await request({ model: "alias", input: "disabled rule" }, undefined, { originator: "Codex Desktop" }, "/proxy/v1/responses")).statusCode, 200);
  store.updateSettings({ downstreamModelRules: [rule] });
  assert.equal((await request({ model: "alias", input: "unmatched client" }, undefined, { originator: "another-client" }, "/proxy/v1/responses")).statusCode, 200);
  assert.deepEqual(sent.map((request) => request.model), ["fixture-model", "fixture-model"]);
});

test("a matched mapping with a disabled or removed target fails instead of silently using a different model", async (t) => {
  const { store, request, app, sent, mapping } = setupModelMapping(t);
  store.updateSettings({ downstreamModelRules: [mapping("App", app.id, [{ source: "header", header: "originator", match: "exact", value: "Codex Desktop" }])] });
  store.upsertRoute({ ...app, enabled: false });
  for (const deleted of [false, true]) {
    if (deleted) store.deleteRoute(app.id);
    const response = await request({ model: "alias", input: "unavailable target" }, undefined, { originator: "Codex Desktop" }, "/proxy/v1/responses");
    assert.equal(response.statusCode, 502);
    assert.match(response.text(), /模型映射「App」的目标路由不存在或已停用/);
  }
  assert.equal(sent.length, 0);
});

test("direct provider mappings forward without a saved route and preserve original model permissions and logs", async (t) => {
  const { store, request, key, sql } = setup(t);
  const site = store.upsertSite({ name: "selected provider", addresses: [{ id: "selected", label: "selected", baseUrl: "https://selected.invalid/v1", enabled: true, models: [] }] });
  store.upsertProviderApiKeyGroup({ siteId: site.id, apiKeys: [{ label: "selected key", secret: "selected-fixture-secret", enabled: true, models: ["selected-model"] }] });
  const rules: DownstreamModelRule[] = [{ id: "direct", name: "provider mapping", model: "mapped-only", enabled: true, targetSiteId: site.id, targetModel: "selected-model", conditions: [] }];
  const routesBefore = structuredClone(store.getDb().routes);
  store.updateSettings({ downstreamModelRules: rules });
  store.updateApiKey(key.id, { models: ["mapped-only"] });
  const sent: Array<{ url: string; model: string; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(url), model: body.model, authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ id: "resp-direct", object: "response", model: body.model, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "direct reply" }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }), { headers: { "content-type": "application/json" } });
  };
  const response = await request({ model: "mapped-only", input: "direct fixture" }, undefined, {}, "/proxy/v1/responses");
  assert.equal(response.statusCode, 200, response.text());
  assert.deepEqual(sent, [{ url: "https://selected.invalid/v1/responses", model: "selected-model", authorization: "Bearer selected-fixture-secret" }]);
  assert.deepEqual(store.getDb().routes, routesBefore, "mapping must not create hidden saved routes");
  const log = store.getRequestLog(store.listRequestLogs()[0].id)!;
  assert.equal(log.upstream?.provider, "selected provider");
  assert.equal(log.upstream?.model, "selected-model");
  assert.equal(log.upstream?.url, "https://selected.invalid/v1/responses");
  assert.equal((sql.prepare("SELECT model FROM usage_records ORDER BY id DESC LIMIT 1").get() as { model: string }).model, "selected-model");
  store.updateApiKey(key.id, { models: ["selected-model"] });
  const denied = await request({ model: "mapped-only", input: "not permitted" }, undefined, {}, "/proxy/v1/responses");
  assert.equal(denied.statusCode, 502);
  assert.match(denied.text(), /不允许使用模型 mapped-only/);
  assert.equal(sent.length, 1);
});

test("unavailable direct targets fail closed instead of using an alias route or a later mapping", async (t) => {
  const { store, request, site, app, sent, mapping } = setupModelMapping(t);
  const group = structuredClone(store.getDb().providerApiKeyGroups.find((group) => group.siteId === site.id)!);
  const originalSite = structuredClone(site);
  store.updateSettings({ downstreamModelRules: [
    { id: "direct", name: "direct", enabled: true, model: "alias", targetSiteId: site.id, targetModel: "upstream-app", conditions: [] },
    mapping("later rule", app.id, [])
  ] });
  const assertUnavailable = async () => {
    const response = await request({ model: "alias", input: "unavailable direct target" }, undefined, {}, "/proxy/v1/responses");
    assert.equal(response.statusCode, 502);
    assert.match(response.text(), /模型映射「direct」的目标供应商或模型不可用/);
    assert.equal(sent.length, 0);
  };
  store.upsertProviderApiKeyGroup({ ...group, apiKeys: group.apiKeys.map((key) => ({ ...key, enabled: false })) });
  await assertUnavailable();
  store.upsertProviderApiKeyGroup({ ...group, apiKeys: group.apiKeys.map((key) => ({ ...key, models: ["fixture-model"] })) });
  await assertUnavailable();
  store.upsertProviderApiKeyGroup(group);
  store.upsertSite({ ...originalSite, enabled: false });
  await assertUnavailable();
  store.upsertSite({ ...originalSite, addresses: originalSite.addresses.map((address) => ({ ...address, enabled: false })) });
  await assertUnavailable();
  store.deleteSite(site.id);
  await assertUnavailable();
});

test("model discovery exposes route and direct aliases with correct conditions, key filtering and list boundaries", async (t) => {
  const { store, handler, key, site, app, mapping } = setupModelMapping(t);
  store.updateApiKey(key.id, { models: ["gpt-5.6-sol"] });
  for (const direct of [true, false]) for (const scoped of [true, false]) for (const format of ["openai", "anthropic"]) for (const project of ["project-a", "project-b"]) for (const projectHeader of ["x-samapi-project", "x-samapi-project-path", "x-samapi-project-name"]) {
    const rule = mapping("model mapping", app.id, scoped ? [projectHeader === "x-samapi-project-name"
      ? { source: "header", header: projectHeader, match: "exact", value: "project-a" }
      : { source: "project", match: "exact", value: "project-a" }] : [], "gpt-5.6-sol");
    store.updateSettings({ downstreamModelRules: [direct ? { ...rule, targetRouteId: undefined, targetSiteId: site.id, targetModel: "upstream-app" } : rule] });
    const req = Object.assign(Readable.from([]), {
      headers: {
        authorization: `Bearer ${key.plainTextKey}`,
        "x-samapi-project-path": projectHeader === "x-samapi-project-name" ? "/work/project-a" : project,
        "x-samapi-project-name": projectHeader === "x-samapi-project-name" ? project : "project-a",
        [projectHeader]: project
      },
      method: "GET", url: "/proxy/v1/models", socket: { remoteAddress: "127.0.0.1" }
    });
    const res = new ResponseRecorder();
    await handler.handleProxy(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, new URL(`http://localhost/proxy/v1/models?format=${format}`));
    assert.equal(res.statusCode, 200);
    const result = JSON.parse(res.text());
    assert.deepEqual(result.data.map((item: { id: string }) => item.id), !scoped || project === "project-a" ? ["gpt-5.6-sol"] : []);
    assert.equal(result.first_id, !scoped || project === "project-a" ? "gpt-5.6-sol" : null);
    assert.equal(result.last_id, result.first_id);
    const log = store.listRequestLogs()[0];
    assert.equal(log.kind, "models");
    assert.equal(log.messageCount, 0);
    assert.equal(log.attemptCount, 0);
  }
});

test("model endpoint logs remain separate for successful, invalid and unauthorized requests but exclude health checks", async (t) => {
  const { store, handler, key } = setup(t);
  globalThis.fetch = async () => { throw new Error("model listing must not request an upstream"); };
  const cases = [
    { method: "GET", pathname: "/proxy/models", status: 200 },
    { method: "GET", pathname: "/proxy/v1/models", status: 200 },
    { method: "GET", pathname: "/proxy/v1/models/", status: 200 },
    { method: "GET", pathname: "/proxy/v1/models", status: 401, invalidKey: true },
    { method: "POST", pathname: "/proxy/v1/models", status: 405 },
    { method: "POST", pathname: "/proxy/v1/models", status: 400, body: "{" },
    { method: "HEAD", pathname: "/proxy/v1/models", status: 200 }
  ];
  for (const [index, item] of cases.entries()) {
    const req = Object.assign(Readable.from(item.body ? [item.body] : []), {
      headers: {
        authorization: `Bearer ${item.invalidKey ? "invalid" : key.plainTextKey}`, "x-samapi-turn-id": "shared-turn", "x-samapi-session-id": "shared-session",
        "x-samapi-project-path": "/work/fixture", "x-samapi-project-name": "fixture"
      },
      method: item.method, url: item.pathname, socket: { remoteAddress: "127.0.0.1" }
    });
    const res = new ResponseRecorder();
    await handler.handleProxy(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, new URL(`http://localhost${item.pathname}`));
    assert.equal(res.statusCode, item.status, res.text());
    assert.equal(store.requestLogCount(), index + 1);
    const summary = store.listRequestLogs()[0];
    assert.equal(summary.kind, item.method === "HEAD" ? undefined : "models");
    assert.deepEqual(store.getRequestLog(summary.id)?.msg, []);
    assert.equal(summary.attemptCount, 0);
  }
});

test("request stages follow body reception, upstream headers and immediate response forwarding for group and Codex routes", async (t) => {
  for (const codex of [false, true]) for (const retryEnabled of [false, true]) {
    await t.test(`${codex ? "Codex" : "group"}, ${retryEnabled ? "retry enabled" : "streaming"}`, { timeout: 3000 }, async (t) => {
      const { store, handler, key, site } = setup(t);
      store.updateSettings({ upstreamRetryCodeCounts: retryEnabled ? [{ statusCode: 599, count: 1 }] : [] });
      const model = codex ? "codex-stages" : "group-stages";
      if (codex) {
        store.saveCodexOAuthAccount({ accessToken: "fixture-access", refreshToken: "fixture-refresh", accountId: "fixture-account", email: "fixture@example.invalid" });
        store.createManagedAccountRoute("gpt", { name: model, model: "gpt-fixture" });
      } else {
        const group = store.getDb().providerApiKeyGroups.find((group) => group.siteId === site.id)!;
        store.upsertRoute({ type: "group", name: model, endpoint: "responses", strategy: "stable-first", matchRule: "fixture-model",
          members: [{ siteId: site.id, apiKeyId: group.apiKeys[0].id, model: "fixture-model" }], enabled: true });
      }
      const assertStage = (stage: RequestLogStage, attemptCount: number) => {
        const summary = store.listRequestLogs()[0];
        const log = store.getRequestLog(summary.id)!;
        assert.equal(summary.result.stage, stage);
        assert.equal(log.result.stage, stage);
        assert.equal(log.calls[0].result.stage, stage);
        assert.equal(summary.attemptCount, attemptCount);
        assert.equal(log.calls[0].attempts.length, attemptCount);
        if (attemptCount) assert.equal(log.calls[0].attempts.at(-1)?.result.stage, stage);
        return log;
      };
      const verifyApiKey = store.verifyApiKey.bind(store);
      t.mock.method(store, "verifyApiKey", (...args: Parameters<typeof store.verifyApiKey>) => {
        assertStage("preparing-upstream", 0);
        return verifyApiKey(...args);
      });
      let releaseHeaders!: (response: Response) => void;
      const headers = new Promise<Response>((resolve) => { releaseHeaders = resolve; });
      let markFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
      let fetchCalls = 0;
      globalThis.fetch = async (target) => {
        fetchCalls++;
        const log = assertStage("waiting-upstream", 1);
        assert.equal(log.upstream?.url, String(target));
        assert.equal(log.upstream?.account?.label, codex ? "fixture@example.invalid" : "fixture");
        assert.ok(log.upstream?.account?.id);
        assert.deepEqual(log.upstream?.userAgent, codex ? { value: CODEX_USER_AGENT, source: "codex" } : { source: "default" });
        assert.equal(String(target), codex ? CODEX_BACKEND_RESPONSES_URL : "https://first.invalid/v1/responses");
        markFetchStarted();
        return headers;
      };
      const req = Object.assign(new Readable({ read() {} }), {
        headers: {
          authorization: `Bearer ${key.plainTextKey}`, "content-type": "application/json",
          "x-samapi-project-path": "/work/fixture", "x-samapi-project-name": "fixture"
        },
        method: "POST", url: "/proxy/v1/responses", socket: { remoteAddress: "127.0.0.1" }
      });
      const res = new ResponseRecorder();
      let markFirstWrite!: () => void;
      const firstWrite = new Promise<void>((resolve) => { markFirstWrite = resolve; });
      const write = res.write.bind(res);
      res.write = (chunk) => { assertStage("forwarding-response", 1); markFirstWrite(); return write(chunk); };
      const pending = handler.handleProxy(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, new URL("http://localhost/proxy/v1/responses"));
      req.push(`{"model":"${model}","stream":true,`);
      await nextTick();
      assertStage("receiving-request", 0);
      assert.equal(fetchCalls, 0, "an incomplete downstream body must not start an upstream request");
      req.push('"input":"analyse"}');
      req.push(null);
      await fetchStarted;
      assertStage("waiting-upstream", 1);
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      releaseHeaders(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } }));
      await nextTick();
      assertStage("receiving-upstream", 1);
      assert.equal(res.headersSent, false);
      const frame = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
      frame({ type: "response.created", response: { id: "resp-stages", status: "in_progress", output: [] } });
      await nextTick();
      assertStage("receiving-upstream", 1);
      frame({ type: "response.output_text.delta", delta: "actual reply" });
      await firstWrite;
      assertStage("forwarding-response", 1);
      assert.equal(res.headersSent, true, "useful output must be forwarded even when 599 retry is enabled");
      frame({ type: "response.completed", response: { id: "resp-stages", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "actual reply" }] }] } });
      await pending;
      const summary = store.listRequestLogs()[0];
      const log = store.getRequestLog(summary.id)!;
      assert.equal(log.result.status, "success");
      assert.equal(log.result.stage, undefined);
      assert.equal(summary.result.stage, undefined);
      assert.equal(log.calls[0].attempts[0].result.stage, undefined);
      assert.equal(log.result.body, "actual reply");
      assert.deepEqual(summary.upstream?.account, log.upstream?.account);
      assert.equal(log.calls[0].attempts[0].upstream?.account?.label, codex ? "fixture@example.invalid" : "fixture");
      assert.equal(fetchCalls, 1);
      assert.equal(res.writableEnded, true);
    });
  }
});

test("retry backoff is a request stage and does not create an upstream attempt before the next fetch", { timeout: 3000 }, async (t) => {
  const { store, request } = setup(t);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 503, count: 1 }] });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const summary = store.listRequestLogs()[0];
    const log = store.getRequestLog(summary.id)!;
    assert.equal(log.result.stage, "waiting-upstream");
    assert.equal(log.result.statusCode, 0);
    assert.equal(log.result.body, "");
    assert.equal(log.calls[0].attempts.length, calls);
    assert.equal(summary.attemptCount, calls);
    return calls === 1 ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ choices: [{ message: { content: "recovered" } }] });
  };
  const pending = request({ model: "alias", messages: [{ role: "user", content: "retry" }] });
  await nextTick();
  const summary = store.listRequestLogs()[0];
  const log = store.getRequestLog(summary.id)!;
  assert.equal(log.result.stage, "waiting-retry");
  assert.equal(summary.result.stage, "waiting-retry");
  assert.equal(log.result.body, "");
  assert.equal(log.calls[0].attempts.length, 1);
  assert.equal(summary.attemptCount, 1);
  assert.equal(log.calls[0].attempts[0].result.status, "failed");
  assert.equal(calls, 1);
  await finishWithRetryTimers(t, pending);
  const completed = store.getRequestLog(summary.id)!;
  assert.equal(completed.result.stage, undefined);
  assert.deepEqual(completed.calls[0].attempts.map((attempt) => attempt.result.statusCode), [503, 200]);
  assert.deepEqual(completed.calls[0].attempts.map((attempt) => attempt.upstream?.account?.label), ["fixture", "fixture"]);
});

test("saving an upstream switch during 599 backoff rebuilds the next request under the original log", { timeout: 3000 }, async (t) => {
  const { store, request } = setup(t);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 2 }] });
  const route = store.getDb().routes.find((route) => route.name === "alias")!;
  const nextSite = store.upsertSite({ name: "replacement", addresses: [{ id: "new", label: "new", baseUrl: "https://replacement.invalid/v1", enabled: true, models: [] }] });
  store.upsertProviderApiKeyGroup({ siteId: nextSite.id, apiKeys: [{ label: "new", secret: "replacement-key", enabled: true, models: ["replacement-model"] }] });
  const template = store.upsertHeaderTemplate({ name: "replacement", headersText: "User-Agent: replacement-client\nX-Upstream-Choice: replacement" });
  const sent: Array<{ target: string; body: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = async (target, init) => {
    sent.push({ target: String(target), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return String(target).includes("first.invalid")
      ? Response.json({ error: { message: "old upstream overloaded" } }, { status: 599 })
      : Response.json({ id: "resp-new", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "new upstream reply" }] }] });
  };
  const pending = request({ model: "alias", messages: [{ role: "user", content: "keep this request" }] });
  await nextTick();
  const original = store.listRequestLogs()[0];
  assert.equal(original.result.stage, "waiting-retry");
  store.upsertRoute({ ...route, type: "switch", siteId: nextSite.id, model: "replacement-model", endpoint: "responses", headerTemplateId: template.id });
  const response = await finishWithRetryTimers(t, pending);
  assert.deepEqual(sent.map((attempt) => attempt.target), ["https://first.invalid/v1/chat/completions", "https://replacement.invalid/v1/responses"]);
  assert.equal(sent[1].body.model, "replacement-model");
  assert.ok(Array.isArray(sent[1].body.input), "the replacement endpoint must receive a newly converted request");
  assert.equal(sent[1].headers.get("authorization"), "Bearer replacement-key");
  assert.equal(sent[1].headers.get("x-upstream-choice"), "replacement");
  assert.equal(response.statusCode, 200);
  assert.match(response.text(), /new upstream reply/);
  const log = store.getRequestLog(original.id)!;
  assert.equal(store.requestLogCount(), 1);
  assert.equal(log.calls.length, 1);
  assert.deepEqual(log.calls[0].attempts.map((attempt) => [attempt.upstream?.url, attempt.result.statusCode]), [
    [sent[0].target, 599], [sent[1].target, 200]
  ]);
  assert.equal(log.upstream?.provider, "replacement");
  assert.equal(log.result.stage, undefined);
  assert.deepEqual(log.calls[0].attempts.map((attempt) => attempt.upstream?.userAgent), [
    { source: "default" },
    { value: sent[1].headers.get("user-agent"), source: "template", template: { id: template.id, name: template.name } }
  ]);
  assert.deepEqual(log.upstream?.userAgent, log.calls[0].attempts[1].upstream?.userAgent);
});

test("logged User-Agent provenance matches forwarded headers and retains template names after edits", async (t) => {
  for (const source of ["template", "downstream", "grok"] as const) await t.test(source, async (t) => {
    const { store, sql, request } = setup(t);
    const template = store.upsertHeaderTemplate({ name: "Original UA template", headersText: "User-Agent: claude-cli/1.0\nX-Template-Secret: fixture-template-secret" });
    let route = store.getDb().routes.find((route) => route.name === "alias")!;
    if (source === "grok") {
      store.importTemporaryAccounts({ providerType: "grok", models: ["grok-fixture"], content: JSON.stringify({
        type: "xai", name: "Grok fixture", access_token: "fixture-grok-access", refresh_token: "fixture-grok-refresh",
        expired: "2099-01-01T00:00:00Z", base_url: "https://grok.invalid/v1"
      }) });
      route = store.createManagedAccountRoute("grok", { name: "grok-route", model: "grok-fixture" });
    }
    store.upsertRoute({ ...route, headerTemplateId: template.id });
    const clientUa = source === "downstream" ? "claude-cli/2.0" : "fixture-client";
    const expected = source === "grok" ? { value: "samapi-grok-oauth/1.0", source } : {
      value: source === "template" ? "claude-cli/1.0" : clientUa, source, template: { id: template.id, name: template.name }
    };
    globalThis.fetch = async (_target, init) => {
      assert.equal(new Headers(init?.headers).get("user-agent"), expected.value);
      const pending = store.getRequestLog(store.listRequestLogs()[0].id)!;
      assert.deepEqual(pending.upstream?.userAgent, expected, "the source must be saved before awaiting upstream headers");
      return source === "grok"
        ? Response.json({ id: "resp-grok", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] })
        : Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    const result = await request({ model: route.name, messages: [{ role: "user", content: "User-Agent provenance" }] }, undefined, { "user-agent": clientUa });
    assert.equal(result.statusCode, 200);
    store.upsertHeaderTemplate({ ...template, name: "Renamed template", headersText: "User-Agent: replacement/1.0" });
    const log = store.getRequestLog(store.listRequestLogs()[0].id)!;
    assert.deepEqual(log.upstream?.userAgent, expected);
    assert.deepEqual(log.calls[0].attempts[0].upstream?.userAgent, expected);
    assert.equal(log.requestHeaders["user-agent"], clientUa);
    assert.equal(JSON.stringify(sql.prepare("SELECT data_json FROM request_logs").all()).includes("fixture-template-secret"), false);
  });
});

test("a switch during the final in-flight attempt uses the new upstream even after the old budget is exhausted", { timeout: 3000 }, async (t) => {
  const { store, request } = setup(t);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 1 }] });
  const route = store.getDb().routes.find((route) => route.name === "alias")!;
  const replacement = store.upsertSite({ name: "replacement", addresses: [{ id: "new", label: "new", baseUrl: "https://replacement.invalid/v1", enabled: true, models: [] }] });
  store.upsertProviderApiKeyGroup({ siteId: replacement.id, apiKeys: [{ label: "new", secret: "replacement-key", enabled: true, models: ["replacement-model"] }] });
  let releaseResponse!: (response: Response) => void;
  const heldResponse = new Promise<Response>((resolve) => { releaseResponse = resolve; });
  let markLastAttempt!: () => void;
  const lastAttempt = new Promise<void>((resolve) => { markLastAttempt = resolve; });
  const sent: string[] = [];
  globalThis.fetch = async (target) => {
    sent.push(String(target));
    if (sent.length === 1) return Response.json({ error: "overloaded" }, { status: 599 });
    if (sent.length === 2) { markLastAttempt(); return heldResponse; }
    return Response.json({ choices: [{ message: { content: "replacement reply" } }] });
  };
  const pending = request({ model: "alias", messages: [{ role: "user", content: "switch while waiting" }] });
  await nextTick();
  t.mock.timers.tick(3000);
  await lastAttempt;
  store.upsertRoute({ ...route, type: "switch", siteId: replacement.id, model: "replacement-model" });
  releaseResponse(Response.json({ error: "last old attempt failed" }, { status: 599 }));
  const response = await finishWithRetryTimers(t, pending);
  assert.deepEqual(sent, ["https://first.invalid/v1/chat/completions", "https://first.invalid/v1/chat/completions", "https://replacement.invalid/v1/chat/completions"]);
  assert.equal(response.statusCode, 200);
  const log = store.getRequestLog(store.listRequestLogs()[0].id)!;
  assert.deepEqual(log.calls[0].attempts.map((attempt) => [attempt.upstream?.model, attempt.result.statusCode]), [["fixture-model", 599], ["fixture-model", 599], ["replacement-model", 200]]);
});

test("retry routing follows group selection, address edits and switches into or out of Codex accounts", async (t) => {
  for (const kind of ["group", "address", "codex-account", "codex-provider", "provider-codex"] as const) {
    await t.test(kind, { timeout: 3000 }, async (t) => {
      const { store, request, site } = setup(t);
      mockRetryTimers(t);
      store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 2 }] });
      let route = store.getDb().routes.find((route) => route.name === "alias")!;
      const nextSite = store.upsertSite({ name: "replacement", addresses: [{ id: "new", label: "new", baseUrl: "https://replacement.invalid/v1", enabled: true, models: [] }] });
      const nextGroup = store.upsertProviderApiKeyGroup({ siteId: nextSite.id, apiKeys: [{ label: "new", secret: "replacement-key", enabled: true, models: ["replacement-model"] }] });
      let expectedTarget = "https://replacement.invalid/v1/chat/completions";
      let expectedKey = "Bearer replacement-key";
      let expectedModel = "replacement-model";
      let changeRoute!: () => void;
      if (kind === "group") {
        const oldGroup = store.getDb().providerApiKeyGroups.find((group) => group.siteId === site.id)!;
        const before = { siteId: site.id, apiKeyId: oldGroup.apiKeys[0].id, model: "fixture-model" };
        const after = { siteId: nextSite.id, apiKeyId: nextGroup.apiKeys[0].id, model: expectedModel };
        route = store.upsertRoute({ type: "group", name: "group-switch", endpoint: "chat/completions", strategy: "specified", members: [before, after], specifiedMember: before });
        changeRoute = () => { store.upsertRoute({ ...route, type: "group", specifiedMember: after }); };
      } else if (kind === "address") {
        expectedTarget = "https://changed.invalid/v1/chat/completions";
        expectedKey = "Bearer fixture-upstream-key";
        expectedModel = "fixture-model";
        changeRoute = () => { store.upsertSite({ ...site, addresses: [{ ...site.addresses[0], baseUrl: "https://changed.invalid/v1", proxy: { mode: "custom", url: "http://127.0.0.1:12345" } }] }); };
      } else {
        const first = store.saveCodexOAuthAccount({ accessToken: "oauth-first", refreshToken: "refresh-first", accountId: "account-first" }).account;
        const second = store.saveCodexOAuthAccount({ accessToken: "oauth-second", refreshToken: "refresh-second", accountId: "account-second" }).account;
        store.setManagedAccountPolicy("gpt", { preferredAccountId: first.id });
        const codexRoute = store.createManagedAccountRoute("gpt", { name: "codex-switch", model: "gpt-fixture" });
        if (kind === "provider-codex") {
          expectedTarget = CODEX_BACKEND_RESPONSES_URL;
          expectedKey = "Bearer oauth-first";
          expectedModel = "gpt-fixture";
          changeRoute = () => { store.upsertRoute({ ...codexRoute, id: route.id, name: route.name }); };
        } else {
          route = codexRoute;
          if (kind === "codex-account") {
            expectedTarget = CODEX_BACKEND_RESPONSES_URL;
            expectedKey = "Bearer oauth-second";
            expectedModel = "gpt-fixture";
            changeRoute = () => { store.setManagedAccountPolicy("gpt", { preferredAccountId: second.id }); };
          } else {
            changeRoute = () => { store.upsertRoute({ ...route, type: "switch", siteId: nextSite.id, model: expectedModel, endpoint: "chat/completions" }); };
          }
        }
      }
      const sent: Array<{ target: string; authorization: string | null; model: string; proxied: boolean }> = [];
      globalThis.fetch = async (target, init) => {
        sent.push({ target: String(target), authorization: new Headers(init?.headers).get("authorization"), model: JSON.parse(String(init?.body)).model, proxied: Boolean((init as RequestInit & { dispatcher?: unknown })?.dispatcher) });
        if (sent.length === 1) return Response.json({ error: { message: "overloaded" } }, { status: 599 });
        if (String(target) === CODEX_BACKEND_RESPONSES_URL) {
          return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-switch", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "switched upstream" }] }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ choices: [{ message: { content: "switched upstream" } }] });
      };
      const pending = request({ model: route.name, messages: [{ role: "user", content: "keep the active request" }] });
      await nextTick();
      const original = store.listRequestLogs()[0];
      assert.equal(original.result.stage, "waiting-retry");
      changeRoute();
      const response = await finishWithRetryTimers(t, pending);
      assert.equal(sent.length, 2);
      assert.equal(sent[1].target, expectedTarget);
      assert.equal(sent[1].authorization, expectedKey);
      assert.equal(sent[1].model, expectedModel);
      assert.equal(sent[1].proxied, kind === "address");
      assert.equal(response.statusCode, 200);
      assert.match(response.text(), /switched upstream/);
      const log = store.getRequestLog(original.id)!;
      assert.equal(log.calls.length, 1);
      assert.equal(store.requestLogCount(), 1);
      assert.deepEqual(log.calls[0].attempts.map((attempt) => attempt.result.statusCode), [599, 200]);
      assert.equal(log.upstream?.url, expectedTarget);
    });
  }
});

test("disabling or deleting a route during retry backoff prevents another request to the old upstream", async (t) => {
  for (const remove of [false, true]) await t.test(remove ? "delete" : "disable", { timeout: 2000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 2 }] });
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ error: "overloaded" }, { status: 599 }); };
    const pending = request({ model: "alias", messages: [{ role: "user", content: "stop the route" }] });
    await nextTick();
    const route = store.getDb().routes.find((route) => route.name === "alias")!;
    if (remove) store.deleteRoute(route.id);
    else store.upsertRoute({ ...route, enabled: false });
    const response = await finishWithRetryTimers(t, pending);
    assert.equal(calls, 1);
    assert.equal(response.statusCode, 502);
    assert.match(response.text(), /路由不存在或已停用/);
    assert.equal(store.listRequestLogs()[0].result.status, "failed");
    assert.equal(store.listRequestLogs()[0].result.stage, undefined);
  });
});

test("unrelated settings and account quota updates preserve the current target and retry budget", { timeout: 3000 }, async (t) => {
  const { store, request } = setup(t);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 2 }] });
  const first = store.saveCodexOAuthAccount({ accessToken: "oauth-fixed", refreshToken: "refresh-fixed", accountId: "account-fixed" }).account;
  store.saveCodexOAuthAccount({ accessToken: "oauth-spare", refreshToken: "refresh-spare", accountId: "account-spare" });
  store.setManagedAccountPolicy("gpt", { preferredAccountId: first.id });
  const route = store.createManagedAccountRoute("gpt", { name: "fixed-retry", model: "gpt-fixture" });
  const sent: Array<string | null> = [];
  globalThis.fetch = async (_target, init) => {
    sent.push(new Headers(init?.headers).get("authorization"));
    return Response.json({ error: "overloaded" }, { status: 599 });
  };
  const pending = request({ model: route.name, messages: [{ role: "user", content: "keep retrying" }] });
  await nextTick();
  store.updateSettings({ maxRequestLogs: 50 });
  store.updateTemporaryAccountCheckResult(first.id, { availability: "available", lastQuotaCheckedAt: new Date().toISOString(), quotaStages: [{ label: "quota", remaining: 50 }] });
  store.upsertRoute({ ...route });
  await finishWithRetryTimers(t, pending);
  assert.deepEqual(sent.slice(0, 3), Array(3).fill("Bearer oauth-fixed"));
  assert.equal(sent.length, 6, "each of the two accounts keeps its original initial attempt plus two retries");
  assert.deepEqual(sent.slice(3), Array(3).fill("Bearer oauth-spare"));
});

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
  assert.equal(store.listRequestLogs()[0].result.stage, undefined);
  assert.equal(store.getRequestLog(store.listRequestLogs()[0].id)?.calls[0].result.stage, undefined);
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

test("custom fixed retry intervals apply to HTTP, transport, streamed errors and Codex", async (t) => {
  for (const kind of ["HTTP", "transport", "stream", "Codex HTTP", "Codex stream"]) await t.test(kind, { timeout: 2000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    const codex = kind.startsWith("Codex");
    const stream = kind.includes("stream");
    if (codex) {
      store.saveCodexOAuthAccount({ accessToken: "fixture-delay-access", refreshToken: "fixture-delay-refresh", accountId: "fixture-delay-account" });
      store.createManagedAccountRoute("gpt", { name: "delay-codex", model: "gpt-fixture" });
    }
    store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 503, count: 1 }, { statusCode: 599, count: 1 }], upstreamRetryDelay: { mode: "fixed", seconds: 2.5 } });
    let calls = 0;
    globalThis.fetch = async () => {
      const failed = ++calls === 1;
      if (failed && kind === "transport") throw new TypeError("fetch failed");
      if (failed && !stream) return Response.json({ error: "busy" }, { status: 503 });
      if (codex) {
        const payload = failed
          ? { type: "response.failed", response: { status: "failed", error: { message: "overloaded" } } }
          : { type: "response.completed", response: { id: "resp-delay", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }] } };
        const delta = failed ? "" : 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg-delay","output_index":0,"content_index":0,"delta":"recovered"}\n\n';
        return new Response(`${delta}event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      if (stream) return new Response(failed ? 'event: error\ndata: {"error":{"message":"overloaded"}}\n\n'
        : 'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      return Response.json({ choices: [{ message: { content: "recovered" } }] });
    };
    const pending = request({ model: codex ? "delay-codex" : "alias", stream, messages: [{ role: "user", content: "custom retry delay" }] });
    await waitForRetryDelay(store, 1);
    assert.equal(calls, 1);
    t.mock.timers.tick(2499); await nextTick();
    assert.equal(calls, 1, "must not retry before the configured interval");
    t.mock.timers.tick(1); await nextTick();
    assert.equal(calls, 2, "must retry at the configured interval");
    const result = await pending;
    assert.equal(result.statusCode, 200, result.text());
    assert.match(result.text(), /recovered/);
  });
});

test("custom random intervals draw a fresh wait within the range for each retry", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 503, count: 2 }], upstreamRetryDelay: { mode: "random", minSeconds: 0.01, maxSeconds: 0.03 } });
  let draws = 0;
  t.mock.method(Math, "random", () => draws++ === 0 ? 0 : 0.999999);
  let calls = 0;
  globalThis.fetch = async () => ++calls <= 2 ? Response.json({ error: "busy" }, { status: 503 }) : Response.json({ choices: [{ message: { content: "recovered" } }] });
  const pending = request({ model: "alias", messages: [{ role: "user", content: "random retry delay" }] });
  await waitForRetryDelay(store, 1);
  t.mock.timers.tick(9); await nextTick(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await waitForRetryDelay(store, 2); assert.equal(calls, 2);
  t.mock.timers.tick(29); await nextTick(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await nextTick(); assert.equal(calls, 3);
  assert.equal((await pending).statusCode, 200);
  assert.equal(draws, 2);
});

test("immediate and zero-duration rules retry without advancing the clock", async (t) => {
  for (const delay of [{ mode: "immediate" }, { mode: "fixed", seconds: 0 }, { mode: "random", minSeconds: 0, maxSeconds: 0 }] as const) {
    await t.test(delay.mode, { timeout: 1000 }, async (t) => {
      const { store, request } = setup(t);
      mockRetryTimers(t);
      store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 503, count: 2 }], upstreamRetryDelay: delay });
      let calls = 0;
      globalThis.fetch = async () => ++calls <= 2 ? Response.json({ error: "busy" }, { status: 503 }) : Response.json({ choices: [{ message: { content: "recovered" } }] });
      assert.equal((await request({ model: "alias", messages: [{ role: "user", content: "immediate retry" }] })).statusCode, 200);
      assert.equal(calls, 3);
    });
  }
});

test("a long retry interval does not delay failover after the configured budget is exhausted", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t, true);
  mockRetryTimers(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 503, count: 1 }], upstreamRetryDelay: { mode: "fixed", seconds: 3600 } });
  const hosts: string[] = [];
  globalThis.fetch = async (target) => {
    hosts.push(new URL(String(target)).hostname);
    return hosts.at(-1) === "first.invalid" ? Response.json({ error: "busy" }, { status: 503 }) : Response.json({ choices: [{ message: { content: "fallback" } }] });
  };
  const pending = request({ model: "alias", messages: [{ role: "user", content: "retry then fail over" }] });
  await waitForRetryDelay(store, 1);
  t.mock.timers.tick(3600000);
  assert.equal((await pending).statusCode, 200);
  assert.deepEqual(hosts, ["first.invalid", "first.invalid", "second.invalid"]);
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
    assert.equal(totals.missingUsageRequests, 0);
    assert.equal(totals.estimatedRequests, recovers ? 2 : 3);
  });
});

test("disabling 599 retries keeps immediate streaming after partial output", { timeout: 2000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 0 }] });
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

test("logged Codex overload after reasoning keeps partial output live while retrying the later request", async (t) => {
  for (const recovers of [true, false]) await t.test(recovers ? "recovers on retry 100" : "exhausts retry 100", { timeout: 10000 }, async (t) => {
    const { store, request } = setup(t);
    mockRetryTimers(t);
    const retries = 100;
    store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: retries }] });
    store.saveCodexOAuthAccount({ accessToken: "fixture-codex-access", refreshToken: "fixture-codex-refresh", accountId: "fixture-chatgpt-account", email: "fixture@example.invalid" });
    store.createManagedAccountRoute("gpt", { name: "gpt-late-overload", model: "gpt-fixture" });
    let calls = 0;
    let cancelled = 0;
    let downstream!: ResponseRecorder;
    const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    globalThis.fetch = async (target) => {
      assert.equal(String(target), "https://chatgpt.com/backend-api/codex/responses");
      const attempt = ++calls;
      assert.equal(downstream.headersSent, attempt > 2, "the second request starts streaming before its retry attempts");
      if (attempt <= 2) assert.equal(downstream.text(), "");
      const succeeds = attempt === 1 || (recovers && attempt === retries + 2);
      const answer = attempt === 1 ? "earlier response" : "recovered response";
      const frames = [sse({ type: "response.created", response: { id: `resp_${attempt}`, output: [] } }),
        sse({ type: "response.reasoning_summary_text.delta", delta: succeeds ? "successful reasoning" : `discarded reasoning ${attempt}` })];
      frames.push(...(succeeds ? [
        sse({ type: "response.output_text.delta", delta: answer }),
        sse({ type: "response.completed", response: { id: `resp_${attempt}`, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }], usage: { input_tokens: 10, output_tokens: 2 } } })
      ] : [sse({ type: "error", error: { code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." } })]));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const text of frames) controller.enqueue(new TextEncoder().encode(text));
          if (!succeeds) controller.close();
        },
        cancel() { cancelled++; }
      }));
    };
    const headers = { "session-id": "fixture-late-session", "x-samapi-turn-id": "fixture-late-turn", "user-agent": CODEX_USER_AGENT };
    const body = { model: "gpt-late-overload", stream: true, input: "continue this turn" };
    const first = await finishWithRetryTimers(t, request(body, (response) => { downstream = response; }, headers, "/proxy/v1/responses"));
    assert.match(first.text(), /earlier response/);
    const logId = store.listRequestLogs()[0].id;
    const result = await finishWithRetryTimers(t, request(body, (response) => { downstream = response; }, headers, "/proxy/v1/responses"), retries * 8 + 40);
    assert.equal(calls, retries + 2);
    assert.ok(cancelled >= 1, "finished or failed attempts release their upstream streams");
    assert.equal(result.statusCode, 200, "headers were committed by the first useful frame");
    assert.match(result.text(), /discarded reasoning 2/);
    assert.doesNotMatch(result.text(), /server_is_overloaded/);
    if (recovers) {
      assert.match(result.text(), /recovered response/);
      assert.equal((result.text().match(/"type":"response.created"/g) || []).length, 1);
    }
    const log = store.getRequestLog(logId)!;
    assert.equal(store.requestLogCount(), 1);
    assert.equal(log.calls.length, 2);
    assert.deepEqual(log.calls[1].attempts.map((attempt) => attempt.result.statusCode), [
      ...Array<number>(retries).fill(599), ...(recovers ? [200] : [])
    ]);
    assert.equal(store.usageReport().totals.requests, calls);
    assert.equal(store.usageReport().totals.missingUsageRequests, 0);
    assert.equal(store.usageReport().totals.estimatedRequests, recovers ? retries : retries + 1);
  });
});

test("configured 599 retries suppress late errors and continue raw or converted streams without delaying output", async (t) => {
  const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const fixtures = [
    {
      endpoint: "chat/completions" as const,
      prefix: sse({ choices: [{ delta: { content: "discarded answer", tool_calls: [{ index: 0, id: "discarded_tool", function: { name: "discarded_action", arguments: "{}" } }] } }] }),
      success: sse({ choices: [{ delta: { content: "recovered answer" } }] }) + sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + "data: [DONE]\n\n"
    },
    {
      endpoint: "responses" as const,
      prefix: sse({ type: "response.reasoning_summary_text.delta", delta: "discarded reasoning" })
        + sse({ type: "response.output_item.added", output_index: 0, item: { id: "discarded_item", type: "function_call", call_id: "discarded_tool", name: "discarded_action", arguments: "{}" } }),
      success: sse({ type: "response.output_text.delta", item_id: "msg_recovered", output_index: 0, content_index: 0, delta: "recovered answer" })
        + sse({ type: "response.completed", response: { id: "resp_recovered", object: "response", status: "completed", model: "fixture-model", output: [{ id: "msg_recovered", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "recovered answer", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } } })
    },
    {
      endpoint: "messages" as const,
      prefix: sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "discarded thinking" } })
        + sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "discarded_tool", name: "discarded_action", input: {} } }),
      success: sse({ type: "message_start", message: { id: "msg_recovered", type: "message", role: "assistant", content: [], model: "fixture-model", usage: { input_tokens: 10, output_tokens: 0 } } })
        + sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered answer" } })
        + sse({ type: "content_block_stop", index: 0 })
        + sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) + sse({ type: "message_stop" })
    }
  ];
  for (const fixture of fixtures) for (const fallback of [false, true]) {
    await t.test(`${fixture.endpoint}, ${fallback ? "fallback after budget exhaustion" : "same target recovery"}`, { timeout: 3000 }, async (t) => {
      const { store, request } = setup(t, fallback);
      mockRetryTimers(t);
      store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: fallback ? 2 : 3 }] });
      store.upsertRoute({ ...store.getDb().routes[0], endpoint: fixture.endpoint });
      let calls = 0;
      let downstream!: ResponseRecorder;
      globalThis.fetch = async (target) => {
        const attempt = ++calls;
        assert.equal(downstream.headersSent, attempt > 1, "the first useful frame commits the downstream response before a retry starts");
        assert.match(String(target), /first\.invalid/);
        if (attempt === 4) return new Response(fixture.success);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(fixture.prefix));
            if (attempt === 1) controller.enqueue(new TextEncoder().encode('event: error\ndata: {"message":"late overload"}\n\n'));
            if (attempt === 3) controller.close();
          },
          pull(controller) { if (attempt === 2) controller.error(new TypeError("terminated after output")); }
        }, { highWaterMark: 0 }));
      };
      // Responses/Claude continue through the same converter after a retry.
      const result = await finishWithRetryTimers(t, request({ model: "alias", stream: true, max_tokens: 1024, messages: [{ role: "user", content: "recover without duplicated actions" }] }, (response) => { downstream = response; }));
      assert.equal(calls, fallback ? 3 : 4);
      assert.equal(result.statusCode, 200);
      assert.match(result.text(), /discarded/, "partial output from failed attempts is delivered immediately");
      if (fallback) assert.doesNotMatch(result.text(), /recovered answer/);
      else assert.match(result.text(), /recovered answer/);
      assert.doesNotMatch(result.text(), /late overload|terminated/);
      const log = store.getRequestLog(store.listRequestLogs()[0].id)!;
      assert.deepEqual(log.calls[0].attempts.map((attempt) => attempt.result.statusCode), fallback ? [599, 599] : [599, 599, 599, 200]);
      const usage = store.usageReport().totals;
      assert.equal(usage.requests, fallback ? 3 : 4);
      assert.equal(usage.totalTokens - usage.estimatedTotalTokens, fallback ? 0 : 12);
      assert.ok(usage.estimatedInputTokens > 0);
      assert.ok(usage.estimatedOutputTokens > 0, "partial generation is included as an explicit estimate");
      assert.equal(usage.missingUsageRequests, 0);
      assert.equal(usage.estimatedRequests, 3);
    });
  }
});

test("client cancellation after streamed reasoning stops immediately without spending the 599 budget", { timeout: 1000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 100 }, { statusCode: 499, count: 1 }] });
  let calls = 0;
  let cancelled = false;
  let downstream!: ResponseRecorder;
  let timer: ReturnType<typeof setTimeout>;
  t.after(() => clearTimeout(timer));
  globalThis.fetch = async () => {
    calls++;
    timer = setTimeout(() => downstream.destroy(), 20);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"still thinking"}}]}\n\n')); },
      cancel() { cancelled = true; }
    }));
  };
  await request({ model: "alias", stream: true, messages: [{ role: "user", content: "cancel buffered reasoning" }] }, (response) => { downstream = response; });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.equal(downstream.headersSent, true);
  assert.match(downstream.text(), /still thinking/);
  assert.equal(store.listRequestLogs()[0].result.statusCode, 499);
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

test("a custom hour-long 599 backoff stops immediately when the client cancels, even with 499 retries configured", { timeout: 1000 }, async (t) => {
  const { store, request } = setup(t);
  store.updateSettings({ upstreamRetryCodeCounts: [{ statusCode: 599, count: 10 }, { statusCode: 499, count: 1 }], upstreamRetryDelay: { mode: "fixed", seconds: 3600 } });
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
    const { account } = store.saveCodexOAuthAccount({ accessToken: "fixture-codex-access", refreshToken: "fixture-codex-refresh", accountId: "fixture-chatgpt-account", email: "fixture@example.invalid" });
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
    const log = store.getRequestLog(store.listRequestLogs()[0].id)!;
    assert.deepEqual(log.calls[0].attempts.map((attempt) => attempt.upstream?.account), [
      { id: account.id, label: "fixture@example.invalid" }, { id: account.id, label: "fixture@example.invalid" }
    ]);
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

test("managed Claude accounts use native auth and protocol, fail over without disabling credentials, and attribute usage to the client", async (t) => {
  const { store, sql, request } = setup(t);
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
  assert.equal(store.temporaryAccountCheckTarget(first.id)?.account.availability, "unknown");
  assert.equal(store.temporaryAccountCheckTarget(second.id)?.account.availability, "available");
  const usage = store.usageReport();
  assert.equal(usage.totals.requests, 2); assert.equal(usage.totals.downstreamRequests, 1); assert.equal(usage.totals.totalTokens, 133); assert.equal(usage.clients[0].apiKeyName, "fixture-client");
  const summary = store.listRequestLogs()[0];
  store.updateManagedAccount(second.id, { label: "renamed second" });
  store.deleteTemporaryAccount(first.id);
  const log = store.getRequestLog(summary.id)!;
  assert.deepEqual(log.upstream?.account, { id: second.id, label: "second" });
  assert.deepEqual(summary.upstream?.account, log.upstream?.account);
  assert.deepEqual(log.calls[0].attempts.map((attempt) => attempt.upstream?.account), [
    { id: first.id, label: "first" }, { id: second.id, label: "second" }
  ]);
  const stored = JSON.stringify(sql.prepare("SELECT data_json FROM request_logs").all());
  assert.equal(stored.includes("fixture-claude-first"), false);
  assert.equal(stored.includes("fixture-claude-second"), false);
});

test("account failover preserves ordinary failures and excludes explicit quota exhaustion from future requests", async (t) => {
  const failures = [
    { name: "authentication", status: 401, error: { message: "Unauthorized" }, exhausted: false },
    { name: "rate limit", status: 429, error: { code: "rate_limit_exceeded", message: "Too many requests" }, exhausted: false },
    { name: "quota code", status: 429, error: { code: "insufficient_quota", message: "Check your plan." }, exhausted: true },
    { name: "usage limit type", status: 429, error: { type: "usage_limit_reached", message: "Please try again later." }, exhausted: true },
    { name: "balance", status: 402, error: { message: "Insufficient Balance" }, exhausted: true }
  ];
  for (const codex of [false, true]) for (const failure of failures) await t.test(`${codex ? "Codex" : "API key"}: ${failure.name}`, async (t) => {
    const { store, request } = setup(t);
    store.updateSettings({ upstreamRetryCodeCounts: [] });
    const addAccount = (name: string) => codex
      ? store.saveCodexOAuthAccount({ accessToken: `fixture-status-${name}`, refreshToken: `fixture-refresh-${name}`, accountId: `fixture-account-${name}` }).account
      : store.createManagedAccount({ provider: "gpt", label: name, secret: `fixture-status-${name}`, models: ["gpt-fixture"] });
    const first = addAccount("first");
    const second = addAccount("second");
    store.updateTemporaryAccountCheckResult(first.id, { availability: "available", quotaStages: [{ label: "quota", remaining: 10 }] });
    store.setManagedAccountPolicy("gpt", { preferredAccountId: first.id });
    const route = store.createManagedAccountRoute("gpt", { name: "status-route", model: "gpt-fixture" });
    const sent: string[] = [];
    globalThis.fetch = async (_target, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      assert.ok(authorization === "Bearer fixture-status-first" || authorization === "Bearer fixture-status-second");
      sent.push(authorization.endsWith("-first") ? "first" : "second");
      if (sent.length === 1) return Response.json({ error: failure.error }, { status: failure.status });
      if (codex) {
        const response = { id: "resp-status", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }] };
        return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "recovered" } }] });
    };
    const result = await request({ model: route.name, messages: [{ role: "user", content: "first request" }] });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(sent, ["first", "second"]);
    assert.equal(store.temporaryAccountCheckTarget(first.id)?.account.availability, failure.exhausted ? "unavailable" : "available");
    const log = store.getRequestLog(store.listRequestLogs()[0].id)!;
    assert.deepEqual(log.calls[0].attempts.map((attempt) => attempt.result.statusCode), [failure.status, 200]);
    assert.deepEqual(log.calls[0].attempts.map((attempt) => attempt.upstream?.account?.id), [first.id, second.id]);
    const next = await request({ model: route.name, messages: [{ role: "user", content: "next request" }] });
    assert.equal(next.statusCode, 200);
    assert.deepEqual(sent, ["first", "second", failure.exhausted ? "second" : "first"]);
  });
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
  assert.deepEqual(store.listRequestLogs()[0].upstream?.account, { id: second.id, label: "second" });
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

test("proxy billing uses upstream cache-write usage and the actual response service tier", async (t) => {
  const { store, sql, request } = setup(t);
  const source = { id: "fixture", name: "Fixture", url: "https://example.com/pricing" };
  store.saveOfficialModelPrices([{ providerId: "", model: "fixture-model", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 2.5, outputUsdPerMillion: 8,
    source, serviceTiers: { priority: { inputUsdPerMillion: 4, cachedInputUsdPerMillion: 1, cacheWriteUsdPerMillion: 5, outputUsdPerMillion: 16 } } }],
    { ...source, status: "success", modelCount: 1, lastSuccessAt: "2026-09-11T00:00:00Z" });
  let tier = "priority";
  globalThis.fetch = async (_target, init) => {
    assert.equal(JSON.parse(String(init?.body)).service_tier, "fast");
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done." } }], service_tier: tier,
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 } } });
  };
  const body = { model: "alias", service_tier: "fast", messages: [{ role: "user", content: "test billing" }] };
  assert.equal((await request(body)).statusCode, 200);
  tier = "default";
  assert.equal((await request(body)).statusCode, 200);
  const records = sql.prepare("SELECT service_tier, cache_write_input_tokens, cost_nano FROM usage_records ORDER BY created_at").all();
  assert.deepEqual(records, [
    { service_tier: "priority", cache_write_input_tokens: 20, cost_nano: 490000 },
    { service_tier: "default", cache_write_input_tokens: 20, cost_nano: 245000 }
  ]);
  assert.equal(store.usageReport().totals.totalTokens, 220);
});
