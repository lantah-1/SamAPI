import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createModelPriceSync } from "../server/model-price-sync.js";
import { createApiHandler } from "../server/handlers/api.js";
import { JsonStore } from "../server/store/index.js";
import { sendJson } from "../server/http.js";

test("usage API authenticates price updates, validates inputs and removes organization billing endpoints", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-billing-api-test-")); const store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  let syncCalls = 0;
  const source = { id: "fixture", name: "Fixture", url: "https://example.com/pricing" };
  const modelPriceSync = createModelPriceSync(store, { sources: [{ ...source, async read() {
    syncCalls++;
    return [{ providerId: "", model: "fixture-model", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 8, source }];
  } }] });
  const handler = createApiHandler({ store, modelPriceSync, hasAdminSession: () => false, renewAdminSession: () => ({ expiresAt: "" }), verifyAdminPassword: () => false,
    createAdminSession: () => ({ token: "", expiresAt: "" }), adminSessionCookie: () => "", clearAdminSessionCookie: () => "",
    requireAdminSession: (req, res) => { if (req.headers["x-fixture-admin"] === "yes") return true; sendJson(res, 401, { error: "Unauthorized" }); return false; },
    checkTemporaryAccounts: unused, checkTemporaryAccountIds: unused, checkSingleTemporaryAccount: unused, resetSingleTemporaryAccount: unused,
    discoverProviderModels: unused, syncAllProviderModels: unused, startCodexOAuth: unused, codexOAuthStatus: () => undefined });
  const request = async (url: string, method = "GET", body?: unknown, authorized = true) => {
    const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, headers: authorized ? { "x-fixture-admin": "yes" } : {} }) as unknown as http.IncomingMessage;
    let status = 0; let text = "";
    const res = { writeHead: (value: number) => { status = value; }, end: (value: string) => { text = value; } } as unknown as http.ServerResponse;
    await handler.handleApi(req, res, new URL(url, "http://localhost"));
    return { status, body: JSON.parse(text) };
  };
  assert.equal((await request("/api/usage", "GET", undefined, false)).status, 401);
  assert.equal((await request("/api/usage/prices/sync", "GET", undefined, false)).status, 401);
  assert.equal((await request("/api/usage/prices/sync", "POST", undefined, false)).status, 401);
  assert.equal(syncCalls, 0);
  assert.equal((await request("/api/usage/openai/config", "PATCH", { adminKey: "secret" }, false)).status, 401);
  assert.equal((await request("/api/usage?from=bad")).status, 400);
  assert.equal((await request("/api/usage?timezoneOffsetMinutes=not-number")).status, 400);
  assert.equal((await request("/api/usage/prices", "POST", { model: "x", providerId: "", inputUsdPerMillion: -1 })).status, 400);
  const price = await request("/api/usage/prices", "POST", { model: "x", providerId: "", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 2 });
  assert.equal(price.status, 200);
  assert.equal((await request("/api/usage/prices")).body.length, 1);
  assert.equal((await request("/api/usage/openai/config", "PATCH", { adminKey: "fixture-secret" })).status, 404);
  assert.equal((await request("/api/usage/openai/config")).status, 404);
  assert.equal((await request("/api/usage/openai")).status, 404);
  assert.equal((await request("/api/usage/unknown")).status, 404);
  await request(`/api/usage/prices/${price.body.id}`, "DELETE");
  assert.equal((await request("/api/usage/prices")).body.length, 0);
  assert.equal((await request("/api/usage/prices/sync")).body.sources[0].status, "pending");
  const synced = await request("/api/usage/prices/sync", "POST");
  assert.equal(synced.status, 200);
  assert.equal(synced.body.sources[0].status, "success");
  assert.equal(synced.body.sources[0].modelCount, 1);
  assert.equal(syncCalls, 1);
  assert.equal((await request("/api/usage/prices")).body[0].source.id, source.id);
  assert.equal((await request("/api/accounts", "GET", undefined, false)).status, 401);
  const account = await request("/api/accounts", "POST", { provider: "deepseek", label: "fixture-account", secret: "fixture-account-private-secret", models: ["deepseek-chat"] });
  assert.equal(account.status, 201); assert.equal(account.body.kind, "api-key");
  assert.equal(JSON.stringify(account.body).includes("fixture-account-private-secret"), false);
  assert.equal(JSON.stringify((await request("/api/accounts")).body).includes("fixture-account-private-secret"), false);
  assert.equal(JSON.stringify((await request("/api/temporary-accounts")).body).includes("fixture-account-private-secret"), false);
  assert.equal((await request(`/api/accounts/${account.body.id}`, "PATCH", { label: "renamed" })).body.label, "renamed");
  assert.equal((await request(`/api/accounts/${account.body.id}/prefer`, "POST")).status, 200);
  assert.equal((await request("/api/accounts/providers/deepseek/route", "POST", { name: "fixture-account-route", model: "deepseek-chat" })).status, 201);
  assert.equal((await request("/api/accounts", "POST", { provider: "other", label: "bad", secret: "fixture" })).status, 400);
  await request(`/api/accounts/${account.body.id}`, "DELETE");
  assert.equal((await request("/api/accounts")).body.providers.find((item: { provider: string }) => item.provider === "deepseek").accounts.length, 0);
});
