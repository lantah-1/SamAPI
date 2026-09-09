import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import type { RequestLogInput } from "../shared/types.js";
import { JsonStore } from "../server/store/index.js";
import { currentUserMessages, logRequestContext, requestToolResults, responseLogLinks } from "../server/log-context.js";
import { createLogResponseCapture } from "../server/log-response.js";

function input(patch: Partial<RequestLogInput> = {}): Omit<RequestLogInput, "id" | "createdAt"> {
  return { routeName: "fixture", method: "POST", path: "/proxy/v1/responses", providerName: "fixture", model: "model",
    userAgent: "fixture", clientIp: "127.0.0.1", status: "pending", statusCode: 0, durationMs: 0,
    requestHeaders: {}, upstreamUrl: "https://example.invalid/v1/responses", ...patch };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-turns-"));
  const store = new JsonStore(dir);
  const sql = new Database(path.join(dir, "samapi.sqlite"));
  t.after(() => { store.close(); sql.close(); rmSync(dir, { recursive: true, force: true }); });
  const begin = (body: unknown, headers: Record<string, string> = {}, scope = "client-one") => {
    const log = store.recordRequestLog(input({ requestBody: body, requestHeaders: headers }));
    store.associateRequestLog(log.id, headers, body, scope);
    return log.id;
  };
  const finish = (id: string, text = "done") => store.updateRequestLog(id, { status: "success", statusCode: 200, responsePreview: text });
  return { store, sql, dir, begin, finish };
}

const turnHeaders = (root: string, turn = root, session = "session-one") => ({
  "session-id": session, "x-codex-turn-metadata": JSON.stringify({ root_turn_id: root, turn_id: turn, session_id: session })
});

test("turn identity is scoped to the client and explicit IDs, while callbacks exclude previous user turns", () => {
  const body = { messages: [{ role: "user", content: "old" }, { role: "tool", tool_call_id: "old-call", content: "old output" }, { role: "user", content: "new" }] };
  assert.deepEqual(currentUserMessages(body), ["new"]);
  assert.deepEqual(requestToolResults(body), []);
  const a = logRequestContext(turnHeaders("root", "child"), body, "client-a");
  assert.equal(a.correlationKey, logRequestContext(turnHeaders("root"), body, "client-a").correlationKey);
  assert.notEqual(a.correlationKey, logRequestContext(turnHeaders("root"), body, "client-b").correlationKey);
  assert.equal(logRequestContext({}, body, "client-a").correlationKey, undefined);
  assert.equal(logRequestContext({}, { input: "new", previous_response_id: "old-response" }, "client-a").previousResponseId, undefined);
  assert.deepEqual(requestToolResults({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "claude-tool", content: [{ type: "text", text: "callback" }], is_error: true }] }] }), [{ callId: "claude-tool", text: "callback", failed: true }]);
  assert.deepEqual(responseLogLinks({ choices: [{ message: { content: '{"tool_calls":[{"id":"fake","function":{"name":"fake"}}]}' } }] }).tools, []);
});

test("one turn owns concurrent requests, retries and tool callbacks without duplicating the current message", (t) => {
  const { store, sql, begin, finish } = fixture(t);
  const headers = turnHeaders("root-one");
  const history = [{ role: "user", content: "previous turn" }, { role: "assistant", content: "old answer" }, { role: "user", content: "分析项目" }];
  const a = begin({ messages: history }, headers);
  store.observeRequestLog(a, "response-one", ["resp-one"], [{ key: "responses:0", callId: "call-one", name: "list_files" }]);
  finish(a, '[工具调用 list_files]\n{"path":"."}');
  assert.equal(store.getRequestLog(a)?.phase, "waiting-tools");
  const nextBody = { messages: [...history, { role: "tool", tool_call_id: "call-one", content: "src/ package.json" }] };
  const b = begin(nextBody, headers);
  const c = begin({ messages: history }, turnHeaders("root-one", "child-turn", "child-session"));
  assert.equal(store.requestLogCount(), 1);
  assert.equal(store.getRequestLog(b)?.id, a);
  assert.equal(store.getRequestLog(a)?.phase, "running");
  store.recordRequestLog(input({ parentRequestId: b, status: "failed", statusCode: 503, responsePreview: "retry me" }));
  finish(b, "analysis part one");
  assert.equal(store.getRequestLog(a)?.phase, "running");
  finish(c, "analysis finished");
  const log = store.getRequestLog(a)!;
  assert.equal(log.phase, "returned");
  assert.deepEqual(log.msg, ["分析项目"]);
  assert.equal(log.calls.length, 3);
  assert.equal(log.calls[1].attempts.length, 2);
  assert.equal(log.tools.length, 1);
  assert.equal(log.tools[0].result, "src/ package.json");
  assert.equal(log.tools[0].resultRequestId, b);
  assert.equal(store.listRequestLogs()[0].attemptCount, 4);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_messages").get() as { n: number }).n, 1);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_message_refs").get() as { n: number }).n, 1);
  const d = begin(nextBody, headers);
  finish(d);
  assert.equal(store.getRequestLog(a)?.tools[0].resultRequestId, b, "repeated conversation history must not re-date the callback");
  const e = begin({ messages: [...history, { role: "user", content: "next question" }] }, turnHeaders("root-two"));
  finish(e);
  assert.equal(store.requestLogCount(), 2);
});

test("tool and previous-response links continue a turn but repeated prompts, other clients and new user inputs stay separate", (t) => {
  const { store, begin, finish } = fixture(t);
  const a = begin({ input: "same words" });
  store.observeRequestLog(a, "one", ["resp-first"], [{ key: "responses:0", callId: "call-link", name: "lookup" }]);
  finish(a);
  const b = begin({ input: [{ type: "function_call_output", call_id: "call-link", output: "result" }] });
  finish(b);
  assert.equal(store.getRequestLog(b)?.id, a);
  const c = begin({ previous_response_id: "resp-first", input: [] });
  finish(c);
  assert.equal(store.getRequestLog(c)?.id, a);
  const newInput = begin({ previous_response_id: "resp-first", input: "same words" });
  finish(newInput);
  assert.notEqual(store.getRequestLog(newInput)?.id, a);
  const otherClient = begin({ input: [{ type: "function_call_output", call_id: "call-link", output: "other client" }] }, {}, "client-two");
  finish(otherClient);
  assert.notEqual(store.getRequestLog(otherClient)?.id, a);
  const repeated = begin({ input: "same words" });
  finish(repeated);
  assert.notEqual(store.getRequestLog(repeated)?.id, a);
  assert.equal(store.requestLogCount(), 4);
});

test("a late root request supplies the original input without a child completion overwriting it", (t) => {
  const { store, begin, finish } = fixture(t);
  const child = begin({ input: "child task" }, turnHeaders("root", "child", "child-session"));
  const parent = begin({ input: "分析项目" }, turnHeaders("root"));
  store.updateRequestLog(child, { requestBody: { input: "child task" }, status: "success", statusCode: 200 });
  finish(parent);
  assert.deepEqual(store.getRequestLog(child)?.msg, ["分析项目"]);
});

test("the standalone result follows the main turn rather than a later concurrent child call", (t) => {
  const { store, begin, finish } = fixture(t);
  const root = begin({ input: "analyse" }, turnHeaders("main-result"));
  const child = begin({ input: "look up files" }, turnHeaders("main-result", "child", "child-session"));
  finish(root, "final main answer");
  assert.equal(store.getRequestLog(root)?.phase, "running");
  finish(child, "child details");
  const detail = store.getRequestLog(root)!;
  assert.equal(detail.result.body, "final main answer");
  assert.equal(detail.phase, "returned");
  assert.equal(detail.calls[1].attempts.at(-1)?.result.body, "child details");
  assert.equal(store.listRequestLogs()[0].result.body, "final main answer");
  const continuation = begin({ input: "analyse" }, turnHeaders("main-result"));
  finish(continuation, "updated main answer");
  assert.equal(store.getRequestLog(root)?.result.body, "updated main answer");
});

test("a turn stores the first masked headers once across different calls, retries and updates", (t) => {
  const { store, sql, begin, finish } = fixture(t);
  const firstHeaders = { ...turnHeaders("shared-headers"), Authorization: "secret", Cookie: "cookie-secret", "X-Api-Key": "api-secret", "x-request-id": "first" };
  const a = begin({ input: "analyse" }, firstHeaders);
  finish(a);
  const b = begin({ input: "analyse" }, { ...turnHeaders("shared-headers"), "x-request-id": "second", "user-agent": "second-agent" });
  store.recordRequestLog(input({ parentRequestId: b, requestHeaders: { "x-request-id": "retry" }, status: "failed", statusCode: 503 }));
  store.updateRequestLog(a, { requestHeaders: { "x-request-id": "overwritten" } });
  finish(b, "final answer");
  const expected = { ...firstHeaders, Authorization: "***", Cookie: "***", "X-Api-Key": "***" };
  const log = store.getRequestLog(b)!;
  assert.equal(log.id, a);
  assert.deepEqual(log.requestHeaders, expected);
  assert.ok(log.calls.every((call) => !("requestHeaders" in call)), "the API must not repeat shared headers per call");
  assert.deepEqual(sql.prepare("SELECT request_headers_json FROM request_log_turns").all(), [{ request_headers_json: JSON.stringify(expected) }]);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_logs WHERE json_type(data_json, '$.requestHeaders') IS NOT NULL").get() as { n: number }).n, 0);
  assert.equal(log.calls.length, 2);
  assert.equal(log.calls[1].attempts.length, 2);
  assert.equal(log.result.body, "final answer");
  const another = begin({ input: "analyse" }, { ...turnHeaders("another-turn"), "x-request-id": "another" });
  finish(another);
  assert.equal(store.getRequestLog(another)?.requestHeaders["x-request-id"], "another");
  store.deleteRequestLog(a);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_turns").get() as { n: number }).n, 1);
  assert.equal(store.getRequestLog(another)?.requestHeaders["x-request-id"], "another");
});

test("a failed request does not leave ghost pending tools after a successful continuation", (t) => {
  const { store, begin, finish } = fixture(t);
  const a = begin({ input: "analyse" }, turnHeaders("failed-stream"));
  store.observeRequestLog(a, "one", [], [{ key: "responses:0", callId: "call-interrupted", name: "lookup" }]);
  store.updateRequestLog(a, { status: "cancelled", statusCode: 499, responsePreview: "client disconnected" });
  assert.equal(store.getRequestLog(a)?.tools[0].status, "cancelled");
  const b = begin({ input: "analyse" }, turnHeaders("failed-stream"));
  finish(b);
  assert.equal(store.getRequestLog(a)?.phase, "returned");
});

test("changed old turns surface in refreshes, and clearing a running turn cannot recreate it or lose unrelated messages", (t) => {
  const { store, sql, begin, finish } = fixture(t);
  const a = begin({ input: "current" }, turnHeaders("a"));
  finish(a);
  const b = begin({ input: "current" }, turnHeaders("b"));
  finish(b);
  sql.prepare("UPDATE request_log_turns SET updated_at = '2000-01-01T00:00:00.000Z'").run();
  store.updateRequestLog(a, { responsePreview: "new result" });
  const revision = store.getRequestLog(a)!.revision;
  store.updateRequestLog(a, { responsePreview: "newer result" });
  assert.ok(store.getRequestLog(a)!.revision > revision, "updates within one millisecond still change the UI revision");
  assert.equal(store.listRequestLogs()[0].id, a);
  assert.deepEqual(store.listNewRequestLogs("2020-01-01T00:00:00.000Z").map((log) => log.id), [a]);
  store.deleteRequestLog(a);
  store.recordRequestLog(input({ parentRequestId: a, status: "failed", statusCode: 503 }));
  store.updateRequestLog(a, { status: "failed" });
  assert.equal(store.requestLogCount(), 1);
  assert.deepEqual(store.getRequestLog(b)?.msg, ["current"]);
  store.clearRequestLogs();
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_logs").get() as { n: number }).n, 0);
  assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_messages").get() as { n: number }).n, 0);
});

test("stream snapshots preserve text and collect split tool identity without storing each token", () => {
  const texts: string[] = [];
  const tools: Array<{ name: string; callId?: string }> = [];
  const capture = createLogResponseCapture({ progress: (text) => texts.push(text), links: (_ids, items) => { tools.splice(0, tools.length, ...items); } });
  capture.push('data: {"choices":[{"delta":{"content":"working"}}]}\n\n');
  assert.deepEqual(texts, ["working"]);
  capture.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-one","function":{"name":"list_","arguments":"{"}}]}}]}\n\n');
  capture.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"files","arguments":"}"}}]}}]}\n\ndata: [DONE]\n\n');
  capture.finish();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "list_files");
  assert.equal(tools[0].callId, "call-one");
  assert.ok(texts.length <= 2);
});

test("a one-turn retention limit preserves the whole continuing tool chain and active concurrent calls", (t) => {
  const { store, begin, finish } = fixture(t);
  store.updateSettings({ maxRequestLogs: 1 });
  const a = begin({ input: "analyse" }, turnHeaders("only-turn"));
  finish(a);
  const b = begin({ input: "analyse" }, turnHeaders("only-turn"));
  const c = begin({ input: "analyse" }, turnHeaders("only-turn", "child"));
  finish(b); finish(c);
  assert.equal(store.requestLogCount(), 1);
  assert.equal(store.getRequestLog(a)?.calls.length, 3);
});

test("stream snapshots flush the latest text even when the upstream pauses before its next frame", { timeout: 1500 }, async () => {
  const texts: string[] = [];
  const capture = createLogResponseCapture({ progress: (text) => texts.push(text), links() {} });
  try {
    capture.push('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    capture.push('data: {"choices":[{"delta":{"content":" second"}}]}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(texts.at(-1), "first second");
  } finally { capture.finish(); }
});

test("upgrading compact logs collapses identifiable old requests, keeps only the current input and preserves restart interruptions", (t) => {
  const { store, sql, dir } = fixture(t);
  const headers = { ...turnHeaders("legacy-root"), "x-client-request-id": "legacy-request" };
  const a = store.recordRequestLog(input({ requestHeaders: headers, requestBody: { messages: [{ role: "user", content: "old turn" }, { role: "user", content: "current turn" }] }, status: "success", statusCode: 200, responsePreview: "recovered response" }));
  store.recordRequestLog(input({ requestHeaders: headers, requestBody: { input: "current turn" }, status: "failed", statusCode: 503, responsePreview: "first attempt failed" }));
  const active = store.recordRequestLog(input({ requestBody: { input: "interrupted" }, responsePreview: "partial response" }));
  // Recreate format 2, where every physical request still carried its own headers.
  sql.prepare(`UPDATE request_logs SET data_json = json_set(data_json, '$.requestHeaders', json(
    (SELECT request_headers_json FROM request_log_turns WHERE id = request_logs.turn_id)))`).run();
  sql.prepare("UPDATE request_log_turns SET request_headers_json = NULL").run();
  sql.prepare("UPDATE meta SET value = '2' WHERE key = 'request_log_format'").run();
  store.close();
  const reopened = new JsonStore(dir);
  try {
    const log = reopened.getRequestLog(a.id)!;
    assert.deepEqual(log.msg, ["current turn"]);
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].attempts.length, 2);
    assert.equal(log.result.status, "success");
    assert.equal(log.result.body, "recovered response");
    assert.equal(reopened.requestLogCount(), 2);
    assert.equal(reopened.getRequestLog(active.id)?.phase, "cancelled");
    assert.match(reopened.getRequestLog(active.id)?.result.body || "", /partial response.*\n.*服务已重启/s);
    assert.equal((sql.prepare("SELECT count(*) AS n FROM request_log_message_refs").get() as { n: number }).n, 2);
  } finally { reopened.close(); }
});

test("format 3 migration removes duplicate headers without losing requests, tools or results and survives another restart", (t) => {
  const { store, sql, dir, begin, finish } = fixture(t);
  const headers = { ...turnHeaders("v3-turn"), authorization: "secret", "user-agent": "first-agent".repeat(100) };
  const a = begin({ input: "analyse" }, headers);
  store.observeRequestLog(a, "one", [], [{ key: "responses:0", callId: "v3-tool", name: "lookup" }]);
  finish(a, "intermediate output");
  const b = begin({ input: [{ type: "function_call_output", call_id: "v3-tool", output: "tool output" }] }, { ...headers, "user-agent": "second-agent".repeat(100) });
  finish(b, "final output");
  const childHeaders = { ...turnHeaders("v3-turn", "child", "child-session"), "user-agent": "child-agent" };
  const child = begin({ input: "child task" }, childHeaders);
  finish(child, "child output");
  const expected = store.getRequestLog(a)!;
  assert.equal(expected.result.body, "final output");
  const putHeaders = sql.prepare("UPDATE request_logs SET data_json = json_set(data_json, '$.requestHeaders', json(?)) WHERE id = ?");
  putHeaders.run(JSON.stringify(expected.requestHeaders), a);
  putHeaders.run(JSON.stringify({ ...expected.requestHeaders, "user-agent": "second-agent".repeat(100) }), b);
  putHeaders.run(JSON.stringify(childHeaders), child);
  const before = (sql.prepare("SELECT sum(length(data_json)) AS n FROM request_logs").get() as { n: number }).n;
  sql.prepare("UPDATE meta SET value = '3' WHERE key = 'request_log_format'").run();
  store.close();
  sql.exec("ALTER TABLE request_log_turns DROP COLUMN request_headers_json");
  sql.exec("ALTER TABLE request_logs DROP COLUMN is_root_request");
  for (let i = 0; i < 2; i++) {
    const reopened = new JsonStore(dir);
    try {
      assert.deepEqual(reopened.getRequestLog(a), expected);
      assert.equal((sql.prepare("SELECT value FROM meta WHERE key = 'request_log_format'").get() as { value: string }).value, "4");
      assert.equal((sql.prepare("SELECT count(*) AS n FROM request_logs WHERE json_type(data_json, '$.requestHeaders') IS NOT NULL").get() as { n: number }).n, 0);
      const after = (sql.prepare("SELECT (SELECT sum(length(data_json)) FROM request_logs) + (SELECT sum(length(request_headers_json)) FROM request_log_turns) AS n").get() as { n: number }).n;
      assert.ok(after < before, "one shared header copy must take less space than the previous repeated headers");
      assert.deepEqual(sql.pragma("foreign_key_check"), []);
    } finally { reopened.close(); }
  }
});
