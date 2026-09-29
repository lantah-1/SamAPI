import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { JsonStore } from "../server/store/index.js";
import { userMessages, responseLogText, LOG_RESULT_MAX_CHARS } from "../server/log-content.js";
import type { RequestLogInput } from "../shared/types.js";

export function logInput(patch: Partial<RequestLogInput> = {}): Omit<RequestLogInput, "id" | "createdAt"> {
  return {
    routeName: "test-route", routeId: "route-1", method: "POST", path: "/proxy/v1/chat/completions",
    providerName: "test-provider", providerId: "provider-1", model: "test-model", userAgent: "test", clientIp: "127.0.0.1",
    status: "success", statusCode: 200, durationMs: 12,
    requestHeaders: { authorization: "secret", "user-agent": "test", "upstream-custom": "original-header" },
    requestBody: { messages: [{ role: "user", content: "你好" }] },
    upstreamUrl: "https://example.invalid/v1/chat/completions",
    responsePreview: "收到",
    ...patch
  };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-log-test-"));
  const store = new JsonStore(dir);
  const sql = new Database(store.sqlitePath);
  t.after(() => { sql.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, sql, dir };
}

test("extracts all user turns across Chat, Responses, Anthropic and Gemini without tool/system history", () => {
  assert.deepEqual(userMessages({ messages: [
    { role: "system", content: "system secret" }, { role: "user", content: "first" },
    { role: "assistant", content: "generated text" },
    { role: "user", content: [{ type: "tool_result", content: "large tool output" }, { type: "text", text: "second" }] },
    { role: "tool", content: "tool output" }
  ], tools: [{ name: "huge schema" }] }), ["first", "second"]);
  assert.deepEqual(userMessages({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "function_call_output", output: "skip" }] }), ["hi"]);
  assert.deepEqual(userMessages({ input: "hello" }), ["hello"]);
  assert.deepEqual(userMessages({ contents: [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ text: "skip" }] }, { role: "user", parts: [{ text: "b" }] }] }), ["a", "b"]);
  assert.deepEqual(userMessages({ truncated: true, preview: '{"messages":[' }), ["[旧日志的请求体已截断，无法恢复完整用户消息]"]);
});

test("only the current user input is retained in full and shared across repeated requests", (t) => {
  const { store, sql } = fixture(t);
  const longMessage = "用户长消息".repeat(7000);
  const history = [{ role: "user", content: "previous user input" }, { role: "assistant", content: "ignored" }, { role: "user", content: longMessage }];
  const a = store.recordRequestLog(logInput({ requestBody: { messages: history } }));
  const b = store.recordRequestLog(logInput({ requestBody: { messages: history } }));
  const c = store.recordRequestLog(logInput({ requestBody: { messages: [...history, { role: "user", content: "last" }] } }));
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_messages").get() as { n: number }).n, 2);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_message_refs").get() as { n: number }).n, 3);
  assert.deepEqual(store.getRequestLog(a.id)?.msg, [longMessage]);
  assert.deepEqual(store.getRequestLog(b.id)?.msg, [longMessage]);
  assert.deepEqual(store.getRequestLog(c.id)?.msg, ["last"]);
  const stored = JSON.parse((sql.prepare("SELECT data_json FROM request_logs WHERE id = ?").get(a.id) as { data_json: string }).data_json);
  assert.deepEqual(Object.keys(stored).sort(), ["result", "upstream"]);
  assert.deepEqual(store.getRequestLog(a.id)?.requestHeaders, { authorization: "***", "user-agent": "test", "upstream-custom": "original-header" });
  assert.equal(stored.result.body, "收到");
  assert.equal(stored.upstream.url, "https://example.invalid/v1/chat/completions");
  assert.equal(store.listRequestLogs(1)[0].msg, "last");
  assert.equal(store.listRequestLogs(1)[0].messageCount, 1);
  const sameTurn = store.recordRequestLog(logInput({ requestBody: { messages: [{ role: "user", content: "repeat" }, { role: "user", content: "repeat" }] } }));
  assert.deepEqual(store.getRequestLog(sameTurn.id)?.msg, ["repeat"]);
});

test("upstream account snapshots survive progress and restart, exclude credentials and can be cleared", (t) => {
  const { store, sql, dir } = fixture(t);
  const account = { id: "account-original", label: "original label", secret: "account-secret", refreshToken: "account-refresh-secret" };
  const expected = { id: account.id, label: account.label };
  const template = { id: "template-original", name: "Original template", headersText: "Authorization: fixture-template-secret" };
  const userAgent = { value: "fixture-agent/1.0", source: "template" as const, template };
  const expectedUserAgent = { ...userAgent, template: { id: template.id, name: template.name } };
  const log = store.recordRequestLog(logInput({ status: "pending", statusCode: 0, upstreamAccount: account, upstreamUserAgent: userAgent }));
  account.label = "renamed after request";
  template.name = "renamed after request";
  store.updateRequestLog(log.id, { stage: "receiving-upstream", responsePreview: "partial reply" });
  assert.deepEqual(store.getRequestLog(log.id)?.upstream?.account, expected);
  assert.deepEqual(store.listRequestLogs()[0].upstream?.account, expected);
  store.updateRequestLog(log.id, { status: "success", statusCode: 200, responsePreview: "finished" });
  const stored = (sql.prepare("SELECT data_json FROM request_logs WHERE id = ?").get(log.id) as { data_json: string }).data_json;
  assert.deepEqual(JSON.parse(stored).upstream.account, expected);
  assert.deepEqual(JSON.parse(stored).upstream.userAgent, expectedUserAgent);
  assert.equal(stored.includes("fixture-template-secret"), false);
  for (const secret of [account.secret, account.refreshToken]) assert.equal(stored.includes(secret), false);
  store.close();
  const reopened = new JsonStore(dir);
  try {
    assert.deepEqual(reopened.getRequestLog(log.id)?.upstream?.account, expected);
    assert.deepEqual(reopened.getRequestLog(log.id)?.upstream?.userAgent, expectedUserAgent);
    assert.deepEqual(reopened.getRequestLog(log.id)?.calls[0].attempts[0].upstream?.account, expected);
    reopened.updateRequestLog(log.id, { upstreamAccount: null, upstreamUrl: "https://template.invalid/v1" });
    assert.equal(reopened.getRequestLog(log.id)?.upstream?.account, undefined);
    assert.equal(reopened.listRequestLogs()[0].upstream?.account, undefined);
  } finally { reopened.close(); }
});

test("pending updates, deletion, retention and configuration saves preserve shared references", (t) => {
  const { store, sql } = fixture(t);
  store.updateSettings({ maxRequestLogs: 2 });
  const a = store.recordRequestLog(logInput({ status: "pending", statusCode: 0, requestBody: undefined, responsePreview: undefined }));
  store.updateRequestLog(a.id, { requestBody: { input: "shared" } });
  store.updateRequestLog(a.id, { status: "success", statusCode: 200, responsePreview: "done" });
  const b = store.recordRequestLog(logInput({ requestBody: { input: "shared" } }));
  const rowId = (sql.prepare("SELECT rowid FROM request_logs WHERE id = ?").get(a.id) as { rowid: number }).rowid;
  store.updateSettings({ themeId: "salt" });
  assert.equal((sql.prepare("SELECT rowid FROM request_logs WHERE id = ?").get(a.id) as { rowid: number }).rowid, rowId);
  assert.deepEqual(store.getRequestLog(a.id)?.msg, ["shared"]);
  store.deleteRequestLog(a.id);
  assert.deepEqual(store.getRequestLog(b.id)?.msg, ["shared"]);
  store.recordRequestLog(logInput({ requestBody: { input: "new" } }));
  store.recordRequestLog(logInput({ requestBody: { input: "newer" } }));
  assert.equal(store.requestLogCount(), 2);
  assert.equal(store.getRequestLog(b.id), undefined);
  assert.deepEqual(sql.prepare("SELECT content FROM request_log_messages ORDER BY content").all(), [{ content: "new" }, { content: "newer" }]);
  store.clearRequestLogs();
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_messages").get() as { n: number }).n, 0);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_message_refs").get() as { n: number }).n, 0);
});

test("migrates old SQLite logs, deduplicates bodies, reclaims pages and keeps stable-routing state", (t) => {
  const { store, sql, dir } = fixture(t);
  const longMessage = "保留用户输入".repeat(6000);
  const legacy = { ...logInput(), id: "legacy-a", createdAt: "2026-09-07T00:00:00.000Z",
    requestBody: { messages: [{ role: "user", content: longMessage }, { role: "assistant", content: "ignored".repeat(50000) }], tools: [{ schema: "x".repeat(100000) }] },
    upstreamRequest: { upstreamUrl: "https://example.invalid/v1/chat/completions", model: "test-model", requestBody: { huge: "x".repeat(100000) } }
  };
  sql.prepare("DELETE FROM meta WHERE key = 'request_log_format'").run();
  const insert = sql.prepare("INSERT INTO request_logs (id, created_at, data_json) VALUES (?, ?, ?)");
  insert.run(legacy.id, legacy.createdAt, JSON.stringify(legacy));
  insert.run("legacy-b", legacy.createdAt, JSON.stringify({ ...legacy, id: "legacy-b" }));
  insert.run("legacy-null", legacy.createdAt, "null");
  const before = (sql.prepare("SELECT sum(length(data_json)) AS n FROM request_logs").get() as { n: number }).n;
  const beforePages = sql.pragma("page_count", { simple: true }) as number;
  store.close();
  const reopened = new JsonStore(dir);
  try {
    assert.deepEqual(reopened.getRequestLog("legacy-a")?.msg, [longMessage]);
    assert.match(reopened.getRequestLog("legacy-null")?.result.body || "", /旧日志格式损坏/);
    assert.equal(reopened.getRouteLastSuccess("route-1"), "provider-1::test-model");
    assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_messages").get() as { n: number }).n, 1);
    const after = (sql.prepare("SELECT (SELECT sum(length(data_json)) FROM request_logs) + (SELECT sum(length(content)) FROM request_log_messages) AS n").get() as { n: number }).n;
    assert.ok(after < before / 10);
    assert.ok((sql.pragma("page_count", { simple: true }) as number) < beforePages);
    t.diagnostic(`fixture payload reduced from ${before} to ${after} characters (${(100 * (1 - after / before)).toFixed(1)}% smaller)`);
    reopened.clearRequestLogs();
    assert.equal(reopened.getRouteLastSuccess("route-1"), "provider-1::test-model");
  } finally { reopened.close(); }
});

test("normalizes upstream results and caps long replies without retaining protocol metadata", () => {
  assert.equal(responseLogText({ choices: [{ message: { content: "chat answer" } }], usage: { total_tokens: 99 } }), "chat answer");
  assert.equal(responseLogText({ output: [{ type: "message", content: [{ type: "output_text", text: "response answer" }] }] }), "response answer");
  assert.equal(responseLogText({ content: [{ type: "text", text: "claude answer" }] }), "claude answer");
  assert.equal(responseLogText({ candidates: [{ content: { parts: [{ text: "gemini answer" }] } }] }), "gemini answer");
  assert.match(responseLogText({ content: [{ type: "tool_use", name: "lookup", input: { q: "test" } }] }), /lookup/);
  assert.equal(responseLogText("x".repeat(LOG_RESULT_MAX_CHARS + 20)).length, LOG_RESULT_MAX_CHARS);
  assert.match(responseLogText("x".repeat(LOG_RESULT_MAX_CHARS + 20)), /已截断/);
});
