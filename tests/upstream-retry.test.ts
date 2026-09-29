import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import Database from "better-sqlite3";
import type { AppSettings, UpstreamRetryDelay } from "../shared/types.js";
import { DEFAULT_UPSTREAM_RETRY_DELAY, normalizeUpstreamRetryDelay, upstreamRetryDelayMs, upstreamRetryDelaySummary } from "../shared/upstream-retry.js";
import { normalizeSettings } from "../server/store/helpers.js";
import { JsonStore } from "../server/store/index.js";
import { createApiHandler } from "../server/handlers/api.js";
import { sendJson } from "../server/http.js";

test("retry delay defaults preserve existing jitter and validate modes, bounds and millisecond precision", () => {
  assert.deepEqual(normalizeSettings().upstreamRetryDelay, DEFAULT_UPSTREAM_RETRY_DELAY);
  assert.notEqual(normalizeUpstreamRetryDelay(), DEFAULT_UPSTREAM_RETRY_DELAY);
  for (const delay of [
    { mode: "immediate" }, { mode: "fixed", seconds: 0 }, { mode: "fixed", seconds: 1.001 }, { mode: "fixed", seconds: 3600 },
    { mode: "random", minSeconds: 0, maxSeconds: 0 }, { mode: "random", minSeconds: 0.001, maxSeconds: 3600 }
  ]) assert.deepEqual(normalizeUpstreamRetryDelay(delay), delay);
  for (const invalid of [null, [], "random", {}, { mode: "other" }, { mode: "fixed" }, { mode: "fixed", seconds: null },
    { mode: "fixed", seconds: "1" }, { mode: "fixed", seconds: true }, { mode: "fixed", seconds: NaN }, { mode: "fixed", seconds: Infinity },
    { mode: "fixed", seconds: -1 }, { mode: "fixed", seconds: 3601 }, { mode: "fixed", seconds: 0.0001 },
    { mode: "random", minSeconds: 2, maxSeconds: 1 }, { mode: "random", minSeconds: 1 }, { mode: "random", minSeconds: "", maxSeconds: 3 }
  ]) assert.throws(() => normalizeUpstreamRetryDelay(invalid), JSON.stringify(invalid));
  assert.deepEqual(normalizeUpstreamRetryDelay({ mode: "immediate", seconds: -1 }), { mode: "immediate" });
});

test("retry delay sampling uses whole milliseconds, includes both bounds and draws separately", () => {
  const unused = () => { throw new Error("fixed and immediate must not draw random values"); };
  assert.equal(upstreamRetryDelayMs({ mode: "immediate" }, unused), 0);
  assert.equal(upstreamRetryDelayMs({ mode: "fixed", seconds: 1.001 }, unused), 1001);
  const range: UpstreamRetryDelay = { mode: "random", minSeconds: 1.001, maxSeconds: 2.001 };
  assert.equal(upstreamRetryDelayMs(range, () => 0), 1001);
  assert.equal(upstreamRetryDelayMs(range, () => 0.999999), 2001);
  let draws = 0;
  const random = () => (draws++ === 0 ? 0 : 0.999999);
  assert.deepEqual([upstreamRetryDelayMs(range, random), upstreamRetryDelayMs(range, random)], [1001, 2001]);
  assert.equal(draws, 2);
  assert.equal(upstreamRetryDelayMs({ mode: "random", minSeconds: 0, maxSeconds: 0 }), 0);
  assert.equal(upstreamRetryDelaySummary(), "随机 1-3 秒");
  assert.equal(upstreamRetryDelaySummary({ mode: "fixed", seconds: 1.25 }), "固定 1.25 秒");
  assert.equal(upstreamRetryDelaySummary({ mode: "immediate" }), "立即重试");
});

test("retry timing persists, migrates old databases and backups, and rejects invalid saves atomically", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-retry-settings-test-"));
  let store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const previous = structuredClone(store.getDb().settings);
  const delay: UpstreamRetryDelay = { mode: "random", minSeconds: 0.25, maxSeconds: 10 };
  const counts = [{ statusCode: 503, count: 2 }];
  store.updateSettings({ upstreamRetryCodeCounts: counts, upstreamRetryDelay: delay });
  assert.deepEqual(store.getDb().settings, { ...previous, upstreamRetryCodeCounts: counts, upstreamRetryDelay: delay });
  store.updateSettings({ themeId: "salt" });
  const saved = structuredClone(store.getDb().settings);
  assert.deepEqual(saved.upstreamRetryDelay, delay);
  assert.throws(() => store.updateSettings({ upstreamRetryCodeCounts: [], upstreamRetryDelay: { mode: "random", minSeconds: 5, maxSeconds: 1 } }));
  assert.deepEqual(store.getDb().settings, saved);
  const backup = store.exportBackup();
  assert.deepEqual(backup.data.settings.upstreamRetryDelay, delay);
  const sqlitePath = store.sqlitePath;
  store.close(); store = new JsonStore(dir);
  assert.deepEqual(store.getDb().settings, saved);
  const sql = new Database(sqlitePath);
  sql.prepare("DELETE FROM settings WHERE key = 'upstreamRetryDelay'").run();
  sql.close(); store.close(); store = new JsonStore(dir);
  assert.deepEqual(store.getDb().settings.upstreamRetryDelay, DEFAULT_UPSTREAM_RETRY_DELAY);
  assert.deepEqual(store.getDb().settings.upstreamRetryCodeCounts, counts);
  store.importBackup(backup);
  assert.deepEqual(store.getDb().settings, saved);
  const legacyBackup = structuredClone(backup);
  delete (legacyBackup.data.settings as Partial<AppSettings>).upstreamRetryDelay;
  store.importBackup(legacyBackup);
  assert.deepEqual(store.getDb().settings.upstreamRetryDelay, DEFAULT_UPSTREAM_RETRY_DELAY);
  const invalidBackup = structuredClone(backup);
  invalidBackup.data.settings.upstreamRetryDelay = { mode: "fixed", seconds: -1 };
  const beforeImport = structuredClone(store.getDb().settings);
  assert.throws(() => store.importBackup(invalidBackup));
  assert.deepEqual(store.getDb().settings, beforeImport);
});

test("settings API authenticates timing updates and returns validation errors without partial saves", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-retry-api-test-"));
  const store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  const handler = createApiHandler({ store, hasAdminSession: () => false, renewAdminSession: () => ({ expiresAt: "" }), verifyAdminPassword: () => false,
    createAdminSession: () => ({ token: "", expiresAt: "" }), adminSessionCookie: () => "", clearAdminSessionCookie: () => "",
    requireAdminSession: (req, res) => { if (req.headers["x-fixture-admin"] === "yes") return true; sendJson(res, 401, { error: "Unauthorized" }); return false; },
    checkTemporaryAccounts: unused, checkTemporaryAccountIds: unused, checkSingleTemporaryAccount: unused, resetSingleTemporaryAccount: unused,
    discoverProviderModels: unused, syncAllProviderModels: unused, startCodexOAuth: unused, codexOAuthStatus: () => undefined });
  const request = async (method: string, body?: unknown, authorized = true) => {
    const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, headers: authorized ? { "x-fixture-admin": "yes" } : {} }) as unknown as http.IncomingMessage;
    let status = 0; let text = "";
    const res = { writeHead: (value: number) => { status = value; }, end: (value: string) => { text = value; } } as unknown as http.ServerResponse;
    await handler.handleApi(req, res, new URL("http://localhost/api/settings"));
    return { status, body: JSON.parse(text) };
  };
  assert.equal((await request("PATCH", { upstreamRetryDelay: { mode: "immediate" } }, false)).status, 401);
  const settings = (await request("GET")).body;
  const updated = await request("PATCH", { upstreamRetryDelay: { mode: "fixed", seconds: 0.125 } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body, { ...settings, upstreamRetryDelay: { mode: "fixed", seconds: 0.125 } });
  const invalid = await request("PATCH", { upstreamRetryCodeCounts: [{ statusCode: 502, count: 3 }], upstreamRetryDelay: { mode: "random", minSeconds: 5, maxSeconds: 2 } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /最短等待时间不能大于最长等待时间/);
  assert.deepEqual((await request("GET")).body, updated.body);
});
