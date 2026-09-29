import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Database from "better-sqlite3";
import { JsonStore } from "../server/store/index.js";
import { createRouting } from "../server/routing.js";
import { createAccountCheck } from "../server/account-check.js";
import { codexUsageCheckResult, refreshCodexTemporaryAccountToken } from "../server/providers/codex.js";
import { xaiQuotaStagesFromHeaders } from "../server/providers/grok.js";
import { temporaryAccountGroupView } from "../server/accounts.js";
import { AccountsView, ManagedAccountRow } from "../src/views/AccountsView.js";
import type { AccountProvider } from "../shared/accounts.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-accounts-test-"));
  const store = new JsonStore(dir); const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; store.close(); rmSync(dir, { recursive: true, force: true }); });
  const add = (provider: AccountProvider, suffix: string, models = [`${provider}-model`]) => store.createManagedAccount({ provider, label: `${provider}-${suffix}`, secret: `fixture-${provider}-secret-${suffix}`, models });
  return { store, dir, add };
}

function exhaustedCodexUsage(credits?: unknown) {
  const rateLimit = {
    allowed: false,
    limit_reached: true,
    primary_window: { used_percent: 100, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 100, limit_window_seconds: 604800 }
  };
  return {
    rate_limit: rateLimit,
    additional_rate_limits: [{ metered_feature: "codex", rate_limit: rateLimit }],
    credits,
    rate_limit_reset_credits: { available_count: 0 }
  };
}

test("Codex Credits keep exhausted quota windows usable only with a positive balance or unlimited credits", () => {
  for (const balance of [25, 0.001, " 25.50 "]) {
    const parsed = codexUsageCheckResult(exhaustedCodexUsage({ balance }));
    assert.equal(parsed.availability, "available", `balance ${balance}`);
    assert.equal(parsed.stages.find((stage) => stage.label === "Credits 余额")?.remaining, typeof balance === "string" ? balance.trim() : balance);
    assert.ok(parsed.stages.filter((stage) => stage.unit === "%").every((stage) => stage.remaining === 0));
  }
  const unlimited = codexUsageCheckResult(exhaustedCodexUsage({ balance: "0", unlimited: true }));
  assert.equal(unlimited.availability, "available");
  assert.equal(unlimited.stages.find((stage) => stage.label === "Credits 余额")?.unlimited, true);
  for (const credits of [undefined, null, {}, { balance: 0 }, { balance: "0", has_credits: true }, { balance: -1 }, { balance: null, has_credits: true }, { balance: " " }, { balance: "unknown" }, { balance: "Infinity" }, { balance: true }]) {
    assert.equal(codexUsageCheckResult(exhaustedCodexUsage(credits)).availability, "unavailable", JSON.stringify(credits));
  }
  assert.equal(codexUsageCheckResult({
    ...exhaustedCodexUsage({ balance: 0 }),
    rate_limit_reset_credits: { available_count: 3 }
  }).availability, "unavailable", "reset cards are not spendable Credits");
  assert.equal(codexUsageCheckResult({
    rate_limit: { allowed: true, primary_window: { used_percent: 20, limit_window_seconds: 18000 } },
    credits: { balance: 0 }
  }).availability, "available", "zero Credits do not disable a usable subscription quota");
});

test("Codex checks restore accounts with Credits to routing and only exclude exhausted quota", async (t) => {
  const { store, dir } = fixture(t);
  const account = store.saveCodexOAuthAccount({ accessToken: "fixture-credits-access", refreshToken: "fixture-credits-refresh", accountId: "fixture-credits-account" }).account;
  const route = store.createManagedAccountRoute("gpt", { name: "credits-route", model: "gpt-fixture" });
  const routing = createRouting(store);
  const checker = createAccountCheck(store);
  // Rechecking must recover the unavailable status saved before Credits affected eligibility.
  store.updateTemporaryAccountCheckResult(account.id, {
    availability: "unavailable",
    quotaStages: [{ label: "总额度 5小时", remaining: 0 }, { label: "Credits 余额", remaining: "25" }],
    lastCheckStatusCode: 200,
    lastCheckError: "Codex 额度已耗尽或当前不允许请求"
  });
  let credits: Record<string, unknown> = {};
  globalThis.fetch = async (target, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${account.secret}`);
    if (String(target) === "https://chatgpt.com/backend-api/wham/usage") return Response.json(exhaustedCodexUsage(credits));
    assert.equal(String(target), "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
    assert.ok(!init?.method || init.method === "GET", "quota checks must not consume reset cards");
    return Response.json({ available_count: 0, credits: [] });
  };
  for (const value of [{ balance: "25" }, { balance: 0.001 }, { balance: null, unlimited: true }]) {
    credits = value;
    const checked = await checker.checkSingleTemporaryAccount(account.id);
    assert.equal(checked.available, 1);
    assert.equal(checked.results[0].errorMessage, undefined);
    assert.equal(store.managedAccounts().providers.find((provider) => provider.provider === "gpt")?.accounts[0].availability, "available");
    const candidate = routing.resolveProxyExecution(route.name).candidates[0];
    assert.equal(candidate.temporaryAccount?.id, account.id);
    routing.markTemporaryAccountAttempt(candidate, 200);
    assert.equal(store.resolveTemporaryOpenAiAccounts("gpt-fixture")[0]?.id, account.id);
  }
  credits = { balance: "0" };
  assert.equal((await checker.checkSingleTemporaryAccount(account.id)).unavailable, 1);
  assert.equal(store.resolveTemporaryOpenAiAccounts("gpt-fixture").length, 0);
  credits = { unlimited: true };
  for (const status of [401, 403, 429]) {
    await checker.checkSingleTemporaryAccount(account.id);
    routing.markTemporaryAccountAttempt(routing.resolveProxyExecution(route.name).candidates[0], status);
    assert.equal(store.resolveTemporaryOpenAiAccounts("gpt-fixture")[0]?.id, account.id, `HTTP ${status} alone must not exclude the account`);
  }
  await checker.checkSingleTemporaryAccount(account.id);
  store.updateManagedAccount(account.id, { enabled: false });
  assert.equal(store.resolveTemporaryOpenAiAccounts("gpt-fixture").length, 0);
  store.updateManagedAccount(account.id, { enabled: true });
  store.close();
  const reopened = new JsonStore(dir); t.after(() => reopened.close());
  assert.equal(reopened.resolveTemporaryOpenAiAccounts("gpt-fixture")[0]?.id, account.id, "unlimited Credits must remain usable after restart");
});

test("request failures preserve account state unless quota is explicitly exhausted", async (t) => {
  for (const kind of ["codex", "api-key"] as const) await t.test(kind, (t) => {
    const { store, add } = fixture(t);
    const account = kind === "codex"
      ? store.saveCodexOAuthAccount({ accessToken: "fixture-status-access", refreshToken: "fixture-status-refresh", accountId: "fixture-status-account" }).account
      : add("gpt", "status", ["gpt-fixture"]);
    const route = store.createManagedAccountRoute("gpt", { name: "status-route", model: "gpt-fixture" });
    const routing = createRouting(store);
    const ordinaryFailures: Array<[number, string?]> = [
      [400, "Invalid encrypted content"],
      [401, "Unauthorized"],
      [403, "ChatGPT access denied"],
      [429],
      [429, "rate_limit_exceeded: Too many requests"],
      [429, "Rate limit reached for requests per minute"],
      [500, "Failed to query quota"],
      [502, "返回了 HTML 页面，请检查 Codex 账号、代理或 ChatGPT 访问状态"],
      [599, "fetch failed"],
      [599, "额度查询超时"],
      [400, "Invalid quota parameter"],
      [499, "quota exhausted"]
    ];
    for (const availability of ["unknown", "available"] as const) {
      store.updateTemporaryAccountCheckResult(account.id, {
        availability,
        quotaStages: [{ label: "剩余额度", remaining: 10 }],
        lastQuotaCheckedAt: "2026-01-01T00:00:00.000Z",
        lastCheckStatusCode: 200
      });
      const before = structuredClone(store.temporaryAccountCheckTarget(account.id)!.account);
      const candidate = routing.resolveProxyExecution(route.name).candidates[0];
      for (const [status, message] of ordinaryFailures) {
        routing.markTemporaryAccountAttempt(candidate, status, message);
        assert.deepEqual(store.temporaryAccountCheckTarget(account.id)?.account, before, `${availability}: ${status} ${message}`);
        assert.equal(store.resolveTemporaryOpenAiAccounts("gpt-fixture")[0]?.id, account.id);
      }
    }
    const quotaFailures: Array<[number, string]> = [
      [429, "insufficient_quota"],
      [429, "usage_limit_reached"],
      [429, "You exceeded your current quota, please check your plan and billing details."],
      [429, "You have hit your usage limit. Please try again later."],
      [402, "Insufficient Balance"],
      [400, "Your credit balance is too low to access the API."],
      [599, "quota exhausted"],
      [429, "额度已耗尽"],
      [402, "余额不足"]
    ];
    for (const [status, message] of quotaFailures) {
      store.updateTemporaryAccountCheckResult(account.id, { availability: "available" });
      routing.markTemporaryAccountAttempt(routing.resolveProxyExecution(route.name).candidates[0], status, message);
      const saved = store.temporaryAccountCheckTarget(account.id)!.account;
      assert.equal(saved.availability, "unavailable", message);
      assert.equal(saved.lastCheckStatusCode, status);
      assert.equal(saved.lastCheckError, message);
      assert.equal(saved.enabled, true);
      assert.equal(store.resolveTemporaryOpenAiAccounts("gpt-fixture").length, 0);
    }
  });
});

test("managed accounts preserve existing GPT OAuth, mask credentials, deduplicate imports and persist provider-specific settings", (t) => {
  const { store, dir, add } = fixture(t);
  const oauth = store.saveCodexOAuthAccount({ accessToken: "fixture-oauth-access-sensitive", refreshToken: "fixture-oauth-refresh-sensitive", accountId: "legacy-account", email: "legacy@example.invalid" }).account;
  const claude = add("claude", "primary"); const deepseek = add("deepseek", "primary"); const gpt = add("gpt", "api");
  const data = store.managedAccounts();
  assert.equal(data.providers.find((item) => item.provider === "gpt")?.accounts.find((item) => item.id === oauth.id)?.kind, "oauth");
  assert.equal(data.providers.find((item) => item.provider === "claude")?.accounts[0].kind, "api-key");
  assert.equal(JSON.stringify(data).includes("fixture-oauth-access-sensitive"), false);
  assert.equal(JSON.stringify(data).includes("fixture-oauth-refresh-sensitive"), false);
  assert.equal(JSON.stringify(data).includes("fixture-claude-secret-primary"), false);
  assert.equal(JSON.stringify(store.getDb().temporaryAccountGroups.map(temporaryAccountGroupView)).includes("fixture-oauth-access-sensitive"), false);
  store.updateManagedAccount(claude.id, { label: "renamed", secret: "", models: ["claude-v2"] });
  assert.equal(store.temporaryAccountCheckTarget(claude.id)?.account.secret, "fixture-claude-secret-primary");
  assert.throws(() => add("claude", "primary"), /相同凭据/);
  assert.throws(() => store.updateManagedAccount(oauth.id, { secret: "replacement" }), /重新授权/);
  assert.throws(() => store.createManagedAccount({ provider: "unknown" as AccountProvider, label: "bad", secret: "secret" }), /不支持/);
  const imported = store.importTemporaryAccounts({ providerType: "gpt", content: JSON.stringify({ api_key: "sk-import-fixture-long-sensitive", name: "imported" }) });
  assert.equal(imported.imported, 1);
  assert.throws(() => store.importTemporaryAccounts({ providerType: "gpt", content: JSON.stringify({ api_key: "sk-import-fixture-long-sensitive" }) }), /没有新的/);
  store.setManagedAccountPolicy("gpt", { preferredAccountId: gpt.id });
  const backup = store.exportBackup(); store.importBackup(backup);
  store.close();
  const reopened = new JsonStore(dir); t.after(() => reopened.close());
  assert.equal(reopened.managedAccounts().providers.find((item) => item.provider === "gpt")?.preferredAccountId, gpt.id);
  assert.equal(reopened.temporaryAccountCheckTarget(deepseek.id)?.account.providerType, "deepseek");
  assert.equal(reopened.temporaryAccountCheckTarget(claude.id)?.account.accountType, "api-key");
  assert.equal(reopened.temporaryAccountCheckTarget(oauth.id)?.account.secret, "fixture-oauth-access-sensitive");
  assert.ok(reopened.getDb().providerApiKeyGroups.some((group) => group.apiKeys.some((key) => key.kind === "account-pool")));
});

test("account rotation is independent per provider, excludes disabled or incompatible accounts, and falls back from an unavailable default", (t) => {
  const { store, add } = fixture(t);
  const a = add("claude", "a"); const b = add("claude", "b");
  const x = add("deepseek", "x"); const y = add("deepseek", "y");
  store.setManagedAccountPolicy("claude", { strategy: "sequential" }); store.setManagedAccountPolicy("deepseek", { strategy: "sequential" });
  assert.equal(store.resolveTemporaryProviderAccounts("claude", "claude-model")[0].id, a.id);
  assert.equal(store.resolveTemporaryProviderAccounts("deepseek", "deepseek-model")[0].id, x.id);
  assert.equal(store.resolveTemporaryProviderAccounts("claude", "claude-model")[0].id, b.id);
  assert.equal(store.resolveTemporaryProviderAccounts("deepseek", "deepseek-model")[0].id, y.id);
  assert.equal(store.resolveTemporaryProviderAccounts("claude", "unsupported-model").length, 0);
  store.setManagedAccountPolicy("claude", { preferredAccountId: b.id });
  assert.equal(store.resolveTemporaryProviderAccounts("claude", "claude-model")[0].id, b.id);
  store.updateTemporaryAccountCheckResult(b.id, { availability: "unavailable", lastCheckStatusCode: 401 });
  assert.equal(store.resolveTemporaryProviderAccounts("claude", "claude-model")[0].id, a.id);
  assert.throws(() => store.setManagedAccountPolicy("claude", { preferredAccountId: b.id }), /默认账号/);
  store.updateManagedAccount(a.id, { enabled: false });
  assert.equal(store.resolveTemporaryProviderAccounts("claude", "claude-model").length, 0);
  store.deleteTemporaryAccount(b.id);
  assert.equal(store.managedAccounts().providers.find((item) => item.provider === "claude")?.preferredAccountId, undefined);
  store.deleteTemporaryAccount(a.id);
  assert.equal(store.managedAccounts().providers.find((item) => item.provider === "claude")?.models.length, 0);
});

test("default account changes affect switch and stable group routing while preserving other provider preferences", (t) => {
  const { store, add } = fixture(t);
  const a = add("claude", "a"); const b = add("claude", "b");
  const route = store.createManagedAccountRoute("claude", { name: "managed", model: "claude-model" });
  assert.equal(route.endpoint, "messages");
  const routing = createRouting(store);
  assert.equal(routing.resolveProxyExecution("managed").candidates[0].temporaryApiKeyAccount?.id, a.id);
  const pool = store.getDb().providerApiKeyGroups.find((group) => group.apiKeys.some((key) => key.kind === "account-pool"))!;
  const groupRoute = store.upsertRoute({ type: "group", name: "managed-group", endpoint: "messages", strategy: "stable-first", modelGroupId: "claude-model", matchRule: "claude-model", members: [{ siteId: pool.siteId, apiKeyId: pool.apiKeys[0].id, model: "claude-model" }], enabled: true });
  const first = routing.resolveProxyExecution("managed-group"); routing.markCandidateSuccess(groupRoute, first.candidates[0]);
  store.setManagedAccountPolicy("claude", { preferredAccountId: b.id });
  assert.equal(routing.resolveProxyExecution("managed").candidates[0].temporaryApiKeyAccount?.id, b.id);
  assert.equal(routing.resolveProxyExecution("managed-group").candidates[0].temporaryApiKeyAccount?.id, b.id);
  const gptA = add("gpt", "api-a"); const gptB = add("gpt", "api-b");
  store.createManagedAccountRoute("gpt", { name: "gpt-managed", model: "gpt-model" });
  assert.equal(routing.resolveProxyExecution("gpt-managed").candidates[0].temporaryApiKeyAccount?.id, gptA.id);
  store.setManagedAccountPolicy("gpt", { preferredAccountId: gptB.id });
  assert.equal(routing.resolveProxyExecution("gpt-managed").candidates[0].temporaryApiKeyAccount?.id, gptB.id);
});

test("provider checks use native authentication, synchronize paginated models and redact errors", async (t) => {
  const { store, add } = fixture(t); const checker = createAccountCheck(store);
  const claude = add("claude", "check"); const deepseek = add("deepseek", "check"); const gemini = add("gemini", "check"); const gpt = add("gpt", "check");
  globalThis.fetch = async (target, init) => {
    const url = new URL(String(target)); const headers = new Headers(init?.headers);
    if (url.hostname === "api.anthropic.com") {
      assert.equal(headers.get("authorization"), null); assert.equal(headers.get("x-api-key"), "fixture-claude-secret-check"); assert.equal(headers.get("anthropic-version"), "2023-06-01");
      return Response.json(url.searchParams.has("after_id") ? { data: [{ id: "claude-two" }], has_more: false } : { data: [{ id: "claude-one" }], has_more: true, last_id: "claude-one" });
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      assert.equal(url.pathname, "/v1beta/models"); assert.equal(headers.get("x-goog-api-key"), "fixture-gemini-secret-check");
      return Response.json(url.searchParams.has("pageToken") ? { models: [{ name: "models/gemini-two" }] } : { models: [{ name: "models/gemini-one" }], nextPageToken: "page-two" });
    }
    if (url.hostname === "api.deepseek.com") { assert.equal(headers.get("authorization"), "Bearer fixture-deepseek-secret-check"); return Response.json({ data: [{ id: "deepseek-chat" }] }); }
    assert.equal(url.hostname, "api.openai.com"); assert.equal(headers.get("authorization"), "Bearer fixture-gpt-secret-check"); return Response.json({ data: [{ id: "gpt-fixture" }] });
  };
  for (const account of [claude, deepseek, gemini, gpt]) assert.equal((await checker.checkSingleTemporaryAccount(account.id)).available, 1);
  assert.deepEqual(store.temporaryAccountCheckTarget(claude.id)?.account.models, ["claude-one", "claude-two"]);
  assert.deepEqual(store.temporaryAccountCheckTarget(gemini.id)?.account.models, ["gemini-one", "gemini-two"]);
  globalThis.fetch = async () => Response.json({ error: { message: "rejected fixture-claude-secret-check" } }, { status: 401 });
  const denied = await checker.checkSingleTemporaryAccount(claude.id);
  assert.equal(denied.unavailable, 1); assert.equal(JSON.stringify(denied).includes("fixture-claude-secret-check"), false);
  globalThis.fetch = async () => Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
  assert.equal((await checker.checkSingleTemporaryAccount(deepseek.id)).unknown, 1);
});

test("account UI exposes provider switching, default status and safely escaped display fields", (t) => {
  const { store, add } = fixture(t); const account = add("claude", "ui");
  const safe = store.updateManagedAccount(account.id, { label: '<script>alert("x")</script>' });
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(ManagedAccountRow, { account: safe, selected: false, busy: false, checking: false, onSelect: noop, onEdit: noop, onCheck: noop, onReset: noop, onToggle: noop, onDelete: noop }));
  assert.match(html, /默认/); assert.match(html, /&lt;script&gt;/); assert.equal(html.includes("fixture-claude-secret-ui"), false);
  const page = renderToStaticMarkup(createElement(AccountsView, { onChanged: async () => {}, onUnauthorized: () => false, onNotify: noop }));
  for (const label of ["GPT", "Grok", "Claude", "DeepSeek", "Gemini", "登录 ChatGPT", "添加 API Key"]) assert.ok(page.includes(label));
});

test("existing Grok OAuth accounts use managed operations, native checks and provider-specific routing without changing credentials", async (t) => {
  const { store, dir, add } = fixture(t);
  const gpt = add("gpt", "kept");
  const imported = store.importTemporaryAccounts({ providerType: "grok", content: "", models: ["grok-fixture"], contents: [
    JSON.stringify({ type: "xai", name: "CPA fixture", access_token: "fixture-grok-cpa-sensitive", refresh_token: "fixture-grok-cpa-refresh", expired: "2099-01-01T00:00:00Z" }),
    JSON.stringify({ provider: "grok_build", name: "Build fixture", access_token: "fixture-grok-build-sensitive", refresh_token: "fixture-grok-build-refresh", expires_at: "2099-01-01T00:00:00Z" })
  ] });
  const [cpa, build] = imported.group.accounts;
  const pools = store.getDb().providerApiKeyGroups.map((group) => group.id);
  const before = store.managedAccounts();
  assert.deepEqual(before.providers.map((provider) => provider.provider), ["gpt", "grok", "claude", "deepseek", "gemini"]);
  const grok = before.providers.find((provider) => provider.provider === "grok")!;
  assert.deepEqual(grok.accounts.map((account) => [account.id, account.kind, account.grokOAuthFormat]), [[cpa.id, "oauth", "cpa-oauth"], [build.id, "oauth", "grok2api-oauth"]]);
  for (const value of [cpa.secret, cpa.refreshToken!, build.secret, build.refreshToken!]) assert.equal(JSON.stringify(before).includes(value), false);
  assert.throws(() => store.updateManagedAccount(cpa.id, { secret: "replacement-api-key" }), /重新授权/);
  assert.throws(() => store.createManagedAccount({ provider: "grok", label: "unsupported", secret: "api-key" }), /OAuth JSON/);
  store.updateSettings({ temporaryAccountStrategy: "stable-first" });
  store.setManagedAccountPolicy("grok", { strategy: "sequential" });
  assert.equal(store.resolveTemporaryProviderAccounts("grok", "grok-fixture")[0].id, cpa.id);
  assert.equal(store.resolveTemporaryProviderAccounts("grok", "grok-fixture")[0].id, build.id);
  const checker = createAccountCheck(store);
  const auth: string[] = [];
  globalThis.fetch = async (target, init) => {
    assert.match(String(target), /\/responses$/);
    assert.equal(JSON.parse(String(init?.body)).model, "grok-fixture");
    auth.push(new Headers(init?.headers).get("authorization")!);
    return Response.json({ id: "resp_fixture", status: "completed", output: [] });
  };
  for (const account of [cpa, build]) assert.equal((await checker.checkSingleTemporaryAccount(account.id)).available, 1);
  assert.deepEqual(auth, [`Bearer ${cpa.secret}`, `Bearer ${build.secret}`]);
  store.updateManagedAccount(cpa.id, { label: "Renamed Grok", enabled: false });
  const route = store.createManagedAccountRoute("grok", { name: "grok-managed", model: "grok-fixture" });
  const routing = createRouting(store);
  assert.equal(routing.resolveProxyExecution(route.name).candidates[0].temporaryApiKeyAccount?.id, build.id);
  assert.deepEqual(store.getDb().providerApiKeyGroups.map((group) => group.id), pools, "management must reuse the existing Grok official pool");
  const savedAccounts = structuredClone(imported.group.accounts);
  store.close();
  const reopened = new JsonStore(dir); t.after(() => reopened.close());
  assert.deepEqual(reopened.getDb().temporaryAccountGroups.find((group) => group.providerType === "grok")?.accounts, savedAccounts);
  assert.equal(reopened.managedAccounts().providers.find((provider) => provider.provider === "grok")?.strategy, "sequential");
  assert.equal(reopened.getDb().routes.find((item) => item.id === route.id)?.name, route.name);
  reopened.deleteTemporaryAccount(cpa.id);
  reopened.deleteTemporaryAccounts([build.id]);
  assert.equal(reopened.managedAccounts().providers.find((provider) => provider.provider === "grok")?.accounts.length, 0);
  assert.ok(reopened.temporaryAccountCheckTarget(gpt.id));
});

test("Grok migration preserves the effective legacy policy and round-trips its new policy in backups", (t) => {
  const { store, dir, add } = fixture(t);
  add("claude", "custom-policy");
  const imported = store.importTemporaryAccounts({ providerType: "grok", content: JSON.stringify({ type: "xai", access_token: "fixture-grok-migration-token", refresh_token: "fixture-grok-migration-refresh" }) });
  const accountId = imported.accountIds[0];
  store.updateSettings({ temporaryAccountStrategy: "random" });
  store.setManagedAccountPolicy("claude", { strategy: "sequential" });
  store.close();
  const sql = new Database(path.join(dir, "samapi.sqlite"));
  sql.prepare("UPDATE meta SET value='1' WHERE key='managed_account_policy_format'").run();
  sql.prepare("UPDATE temporary_account_groups SET strategy='stable-first' WHERE provider_type='grok'").run();
  sql.close();
  const reopened = new JsonStore(dir); t.after(() => reopened.close());
  const state = () => reopened.managedAccounts().providers.find((provider) => provider.provider === "grok")!;
  assert.equal(state().strategy, "random", "legacy Grok followed the global policy despite stale group settings");
  assert.equal(state().accounts[0].id, accountId);
  assert.equal(reopened.managedAccounts().providers.find((provider) => provider.provider === "claude")?.strategy, "sequential");
  reopened.setManagedAccountPolicy("grok", { strategy: "sequential" });
  const backup = reopened.exportBackup();
  assert.equal(backup.accountPolicyVersion, 2);
  reopened.importBackup(backup);
  assert.equal(state().strategy, "sequential");
  backup.accountPolicyVersion = 1;
  reopened.importBackup(backup);
  assert.equal(state().strategy, "random");
  assert.equal(state().accounts[0].id, accountId);
});

test("Grok quota headers distinguish missing usage from an explicitly exhausted quota", () => {
  assert.deepEqual(xaiQuotaStagesFromHeaders(new Headers()), []);
  assert.deepEqual(xaiQuotaStagesFromHeaders(new Headers({ "x-ratelimit-remaining-requests": " " })), []);
  const stages = xaiQuotaStagesFromHeaders(new Headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-limit-requests": "100" }));
  assert.equal(stages.length, 1);
  assert.equal(stages[0].remaining, 0);
  assert.equal(stages[0].total, 100);
});

test("late account checks do not overwrite newly replaced credentials or recreate deleted accounts", async (t) => {
  const { store, add } = fixture(t); const checker = createAccountCheck(store);
  const account = add("deepseek", "race");
  let release!: (response: Response) => void;
  globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
  const pending = checker.checkSingleTemporaryAccount(account.id);
  store.updateManagedAccount(account.id, { secret: "fixture-new-secret", models: ["new-model"] });
  release(Response.json({ error: { message: "old key rejected" } }, { status: 401 }));
  const result = await pending;
  assert.equal(result.results[0].status, "cancelled");
  assert.equal(store.temporaryAccountCheckTarget(account.id)?.account.availability, "unknown");
  assert.deepEqual(store.temporaryAccountCheckTarget(account.id)?.account.models, ["new-model"]);
  const deletedPending = checker.checkSingleTemporaryAccount(account.id);
  store.deleteTemporaryAccount(account.id);
  release(Response.json({ data: [{ id: "old-model" }] }));
  assert.equal((await deletedPending).results[0].status, "cancelled");
  assert.equal(store.temporaryAccountCheckTarget(account.id), undefined);
});

test("OAuth refresh updates expiry and short credentials remain masked in legacy management responses", async (t) => {
  const { store } = fixture(t);
  const oauth = store.saveCodexOAuthAccount({ accessToken: "fixture-old-access", refreshToken: "fixture-refresh", accountId: "fixture-id", tokenExpiresAt: "2020-01-01T00:00:00.000Z" }).account;
  globalThis.fetch = async () => Response.json({ access_token: "fixture-new-access", refresh_token: "fixture-new-refresh", expires_in: 3600 });
  const patch = await refreshCodexTemporaryAccountToken(oauth);
  assert.ok(patch?.tokenExpiresAt && Date.parse(patch.tokenExpiresAt) > Date.now() + 3500 * 1000);
  store.updateTemporaryAccountCheckResult(oauth.id, patch!);
  assert.equal(store.temporaryAccountCheckTarget(oauth.id)?.account.tokenExpiresAt, patch?.tokenExpiresAt);
  const short = store.createManagedAccount({ provider: "deepseek", label: "short fixture", secret: "tiny-key" });
  const group = store.temporaryAccountCheckTarget(short.id)!.group;
  assert.equal(JSON.stringify(temporaryAccountGroupView(group)).includes("tiny-key"), false);
});

test("upgrade preserves the old global account strategy and retains customized provider addresses", (t) => {
  const { store, dir, add } = fixture(t);
  const first = add("claude", "custom");
  const siteId = store.temporaryAccountCheckTarget(first.id)!.group.siteId;
  const site = store.getDb().sites.find((item) => item.id === siteId)!;
  store.upsertSite({ ...site, addresses: site.addresses.map((address) => ({ ...address, baseUrl: "https://custom-provider.invalid/v1" })) });
  const siteCount = store.getDb().sites.length;
  add("claude", "custom-two");
  assert.equal(store.getDb().sites.length, siteCount);
  store.updateSettings({ temporaryAccountStrategy: "random" });
  store.close();
  const sql = new Database(path.join(dir, "samapi.sqlite"));
  sql.prepare("DELETE FROM meta WHERE key = 'managed_account_policy_format'").run();
  sql.prepare("UPDATE temporary_account_groups SET strategy = 'stable-first', preferred_account_id = NULL").run();
  sql.close();
  const reopened = new JsonStore(dir); t.after(() => reopened.close());
  const state = reopened.managedAccounts().providers.find((item) => item.provider === "claude")!;
  assert.equal(state.strategy, "random");
  assert.equal(state.siteId, siteId);
  assert.equal(reopened.getDb().sites.find((item) => item.id === siteId)?.addresses[0].baseUrl, "https://custom-provider.invalid/v1");
  const oldBackup = reopened.exportBackup();
  delete oldBackup.accountPolicyVersion;
  oldBackup.data.temporaryAccountGroups[0].strategy = "stable-first";
  reopened.importBackup(oldBackup);
  assert.equal(reopened.managedAccounts().providers.find((item) => item.provider === "claude")?.strategy, "random");
});
