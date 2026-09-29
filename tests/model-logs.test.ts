import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { JsonStore } from "../server/store/index.js";
import type { RequestLogInput } from "../shared/types.js";

const modelsBody = JSON.stringify({ modelCount: 2, models: ["first", "second"] });
const turnHeaders = { "x-samapi-turn-id": "same-turn", "x-samapi-session-id": "same-session" };

function input(patch: Partial<RequestLogInput> = {}): Omit<RequestLogInput, "id" | "createdAt"> {
  return { routeName: "proxy-models", method: "GET", path: "/proxy/v1/models", providerName: "模型列表", model: "模型列表",
    userAgent: "fixture", clientIp: "127.0.0.1", requestHeaders: turnHeaders,
    status: "success", statusCode: 200, durationMs: 0, responsePreview: modelsBody, ...patch };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-model-log-test-"));
  const store = new JsonStore(dir);
  const sql = new Database(store.sqlitePath);
  t.after(() => { sql.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, sql, dir };
}

test("model-list paths get an explicit kind that survives updates and never stores synthetic user input", (t) => {
  const { store, sql, dir } = fixture(t);
  const ids: string[] = [];
  for (const pathname of ["/proxy/models", "/proxy/v1/models", "/proxy/v1/models/", "/proxy/v1/models?format=anthropic", "/api/provider-key-groups/discover-models"]) {
    const log = store.recordRequestLog(input({ path: pathname, status: "pending", statusCode: 0, responsePreview: "", requestBody: { input: "not a conversation" } }));
    ids.push(log.id);
    assert.equal(store.getRequestLog(log.id)?.kind, "models");
    store.associateRequestLog(log.id, turnHeaders, { input: "not a conversation" }, "client");
    store.updateRequestLog(log.id, { status: "success", statusCode: 200, responsePreview: modelsBody, requestBody: { input: "still not a conversation" } });
    const detail = store.getRequestLog(log.id)!;
    assert.equal(detail.kind, "models");
    assert.deepEqual(detail.msg, []);
    assert.equal(detail.result.body, modelsBody);
    assert.equal(detail.calls.length, 1);
    assert.equal(detail.calls[0].attempts.length, 0);
    const summary = store.listRequestLogs().find((item) => item.id === log.id)!;
    assert.equal(summary.kind, "models");
    assert.equal(summary.msg, "");
    assert.equal(summary.messageCount, 0);
  }
  assert.equal(store.requestLogCount(), ids.length);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_messages").get() as { n: number }).n, 0);
  store.close();
  const reopened = new JsonStore(dir);
  try { for (const id of ids) assert.equal(reopened.getRequestLog(id)?.kind, "models"); }
  finally { reopened.close(); }
});

test("model polling stays independent before and after a conversation with identical turn headers", (t) => {
  const { store } = fixture(t);
  const begin = (value: Omit<RequestLogInput, "id" | "createdAt">) => {
    const log = store.recordRequestLog(value);
    store.associateRequestLog(log.id, turnHeaders, value.requestBody, "client");
    return log.id;
  };
  const first = begin(input());
  const chat = begin(input({ method: "POST", path: "/proxy/v1/responses", requestBody: { input: "real user input" }, responsePreview: "real answer" }));
  const second = begin(input());
  assert.equal(store.requestLogCount(), 3);
  assert.equal(store.getRequestLog(first)?.kind, "models");
  assert.equal(store.getRequestLog(second)?.kind, "models");
  const conversation = store.getRequestLog(chat)!;
  assert.equal(conversation.kind, undefined);
  assert.deepEqual(conversation.msg, ["real user input"]);
  assert.equal(conversation.result.body, "real answer");
  assert.equal(conversation.calls.length, 1);
});

test("health checks, Gemini generation and similarly named routes are not model-list operations", (t) => {
  const { store } = fixture(t);
  for (const patch of [
    { method: "HEAD" },
    { method: "POST", path: "/proxy/v1/models/example:generateContent" },
    { method: "POST", path: "/proxy/v1/models/example:streamGenerateContent" },
    { method: "POST", path: "/proxy/v1/responses", routeName: "获取模型", requestBody: { input: "获取模型" } }
  ]) {
    const log = store.recordRequestLog(input(patch));
    assert.equal(store.getRequestLog(log.id)?.kind, undefined);
  }
});

test("format 4 backfills known standalone model logs without changing IDs, times, results or ordinary conversations", (t) => {
  const { store, sql, dir } = fixture(t);
  // The old compact format has no path or kind. Recreate both proxy and provider discovery logs.
  const old = store.recordRequestLog(input({ path: "/legacy", responsePreview: JSON.stringify({ modelCount: 0, models: [] }) }));
  store.associateRequestLog(old.id, turnHeaders, {}, "client");
  const discovery = store.recordRequestLog(input({ path: "/legacy", model: "模型发现：2 个模型", upstreamUrl: "https://provider.invalid/v1/models", responsePreview: '{"data":[{"id":"first"},{"id":"second"}]}' }));
  const ordinary = store.recordRequestLog(input({ path: "/legacy", requestBody: { input: "real user input" } }));
  const generated = store.recordRequestLog(input({ path: "/legacy", model: "real-model", upstreamUrl: "https://provider.invalid/v1/responses" }));
  const malformed = store.recordRequestLog(input({ path: "/legacy", responsePreview: '{"modelCount":2,"models":["partial' }));
  const unrelated = store.recordRequestLog(input({ path: "/legacy", responsePreview: '{"modelCount":2,"models":["first"],"extra":true}' }));
  const expected = [old, discovery, ordinary, generated, malformed, unrelated].map((item) => store.getRequestLog(item.id)!);
  sql.prepare("UPDATE meta SET value = '4' WHERE key = 'request_log_format'").run();
  store.close();
  for (let pass = 0; pass < 2; pass++) {
    const reopened = new JsonStore(dir);
    try {
      for (const [index, before] of expected.entries()) {
        const after = reopened.getRequestLog(before.id)!;
        assert.deepEqual(after, index < 2 ? { ...before, kind: "models" } : before);
        assert.equal(reopened.listRequestLogs().find((item) => item.id === before.id)?.kind, index < 2 ? "models" : undefined);
      }
      if (pass === 0) {
        const chat = reopened.recordRequestLog(input({ method: "POST", path: "/proxy/v1/responses", requestBody: { input: "new user turn" } }));
        reopened.associateRequestLog(chat.id, turnHeaders, { input: "new user turn" }, "client");
        assert.equal(reopened.getRequestLog(chat.id)?.id, chat.id, "the old model request must release its conversation correlation key");
        assert.equal(reopened.requestLogCount(), expected.length + 1);
      }
      assert.deepEqual(sql.pragma("foreign_key_check"), []);
    } finally { reopened.close(); }
  }
});

test("full legacy records use their original path to classify even failed model discovery", (t) => {
  const { store, sql, dir } = fixture(t);
  const legacy = { ...input({ path: "/api/provider-key-groups/discover-models", method: "POST", status: "failed", statusCode: 502, responsePreview: "provider unavailable" }),
    id: "legacy-model-discovery", createdAt: "2026-09-01T00:00:00.000Z" };
  sql.prepare("INSERT INTO request_logs (id, created_at, data_json) VALUES (?, ?, ?)").run(legacy.id, legacy.createdAt, JSON.stringify(legacy));
  sql.prepare("DELETE FROM meta WHERE key = 'request_log_format'").run();
  store.close();
  const reopened = new JsonStore(dir);
  try {
    const log = reopened.getRequestLog(legacy.id)!;
    assert.equal(log.kind, "models");
    assert.deepEqual(log.msg, []);
    assert.equal(log.result.body, "provider unavailable");
    assert.equal(log.result.status, "failed");
  } finally { reopened.close(); }
});
