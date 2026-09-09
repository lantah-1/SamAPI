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
import { refreshCodexTemporaryAccountToken } from "../server/providers/codex.js";
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
  const html = renderToStaticMarkup(createElement(ManagedAccountRow, { account: safe, selected: false, busy: false, checking: false, onSelect: noop, onEdit: noop, onPrefer: noop, onCheck: noop, onReset: noop, onToggle: noop, onDelete: noop }));
  assert.match(html, /默认/); assert.match(html, /设为默认/); assert.match(html, /&lt;script&gt;/); assert.equal(html.includes("fixture-claude-secret-ui"), false);
  const page = renderToStaticMarkup(createElement(AccountsView, { onChanged: async () => {}, onUnauthorized: () => false, onNotify: noop }));
  for (const label of ["GPT", "Claude", "DeepSeek", "Gemini", "登录 ChatGPT", "添加 API Key"]) assert.ok(page.includes(label));
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
