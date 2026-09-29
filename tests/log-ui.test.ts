import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LogDetailModal, LogsView } from "../src/views/SystemViews.js";
import type { AppSnapshot, RequestLog, RequestLogStage } from "../shared/types.js";

test("model-list logs use dedicated labels in the list and detail without pretending there was a user message", () => {
  for (const source of ["local", "provider", "failed"] as const) {
    const createdAt = "2026-09-15T03:55:44.023Z";
    const upstream = source === "provider" ? { provider: "fixture provider", model: "模型发现：2 个模型", url: "https://provider.invalid/v1/models" } : undefined;
    const result = { status: source === "failed" ? "failed" as const : "success" as const, statusCode: source === "failed" ? 401 : 200,
      body: source === "failed" ? "Invalid API key" : '{"modelCount":2,"models":["first","second"]}' };
    const log: RequestLog = { id: "model-log", createdAt, updatedAt: createdAt, revision: 1, kind: "models", requestHeaders: {}, msg: [], upstream, result,
      phase: source === "failed" ? "failed" : "returned", tools: [], calls: [{ id: "model-log", createdAt, updatedAt: createdAt, result,
        attempts: upstream ? [{ id: "model-log", createdAt, updatedAt: createdAt, upstream, result }] : [] }] };
    const snapshot = { requestLogs: [{ ...log, msg: "", messageCount: 0, requestCount: 1, attemptCount: upstream ? 1 : 0, toolCount: 0 }] } as unknown as AppSnapshot;
    const list = renderToStaticMarkup(React.createElement(LogsView, {
      snapshot, total: 1, pageSize: 20, autoRefresh: false, refreshing: false, loadingMore: false, selectedLogId: null,
      onAutoRefresh() {}, onLoadMore() {}, onOpenLog() {}, onCloseLog() {}, onDelete() {}, onClear() {}, onCopy() {}
    }));
    const detail = renderToStaticMarkup(React.createElement(LogDetailModal, { log, loading: false, error: "", onClose() {}, onDelete() {} }));
    assert.ok(list.includes("模型来源"));
    assert.ok(list.includes("1 条日志"));
    assert.ok(detail.includes("获取模型日志"));
    for (const html of [list, detail]) {
      assert.ok(html.includes("获取模型"));
      for (const absent of ["当次用户输入", "无用户消息", "此请求未携带用户输入", "暂无上游信息"]) assert.ok(!html.includes(absent), absent);
      if (source === "local") assert.ok(html.includes("无需请求上游"));
      else assert.ok(!html.includes("无需请求上游"));
      if (source === "failed") assert.ok(html.includes("Invalid API key"));
      if (source === "provider") assert.ok(html.includes("fixture provider"));
    }
    if (source !== "failed") assert.ok(detail.includes("modelCount"), "the original model list stays available in the result");
  }
});

test("turn details show one user input with ordered requests, retries and tool callbacks and escape their text", () => {
  const createdAt = "2026-09-07T00:00:00.000Z";
  const upstream = { provider: "fixture", model: "model", url: "https://example.invalid/v1",
    userAgent: { value: "actual-agent/1.0", source: "template" as const, template: { id: "template-one", name: "UA <template>" } } };
  const result = { status: "success" as const, statusCode: 200, body: "actual reply\nsecond line" };
  const html = renderToStaticMarkup(React.createElement(LogDetailModal, {
    log: {
      id: "log-test", createdAt, updatedAt: createdAt, revision: 1, requestHeaders: { authorization: "***", "user-agent": "original-client/1.0" },
      msg: ["<script>alert(1)</script>"], upstream, result, phase: "returned",
      calls: [
        { id: "request-one", createdAt, updatedAt: createdAt, result,
          attempts: [{ id: "attempt-failed", createdAt, updatedAt: createdAt, upstream, result: { status: "failed", statusCode: 503, body: "retry error" } }, { id: "attempt-ok", createdAt, updatedAt: createdAt, upstream, result }] },
        { id: "request-two", createdAt, updatedAt: createdAt, result,
          attempts: [{ id: "attempt-two", createdAt, updatedAt: createdAt, upstream, result }] }
      ],
      tools: [{ id: "tool-one", requestId: "request-one", resultRequestId: "request-two", callId: "call-one", name: "list_files", createdAt, updatedAt: createdAt, status: "success", result: "<img src=x onerror=alert(1)>" }]
    },
    loading: false, error: "", onClose() {}, onDelete() {}
  }));
  for (const label of ["下游请求头", "当次用户输入", "最终结果", "调用过程", "上游结果", "接口调用 1", "接口调用 2", "retry error", "list_files", "已回传"]) assert.ok(html.includes(label), label);
  for (const label of ["下游 Body", "来源 IP", "耗时", "代理模式", "消息 1", "消息 2"]) assert.ok(!html.includes(label), label);
  assert.ok(html.includes("actual reply\nsecond line"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;img"));
  assert.equal(html.match(/下游请求头/g)?.length, 1);
  const headers = html.match(/class="[^"]*log-shared-headers[^"]*"[^>]*>([\s\S]*?)<\/details>/)?.[1] || "";
  for (const value of ["X-Samapi-Upstream-User-Agent", "X-Samapi-Upstream-User-Agent-Source", "header template: UA &lt;template&gt;", "actual-agent/1.0", "original-client/1.0"]) assert.ok(headers.includes(value), value);
  const chain = html.match(/<details\b[^>]*class="[^"]*log-call-chain[^"]*"[^>]*>/);
  assert.ok(chain);
  assert.doesNotMatch(chain[0], /\bopen(?:=|\s|>)/, "the call chain is collapsed by default");
  const finalResult = html.match(/<section\b[^>]*aria-label="最终结果"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(finalResult);
  assert.ok(finalResult[1].includes("actual reply\nsecond line"));
  assert.ok(!finalResult[1].includes("https://example.invalid/v1"));
  assert.ok(!finalResult[1].includes("账号："));
  assert.ok(!finalResult[1].includes("status-badge"));
  assert.ok(!finalResult[1].includes("retry error"));
  assert.ok(html.indexOf(finalResult[0]) < html.indexOf(chain[0]), "the final result is visible outside and before the collapsed chain");
});

test("the standalone result distinguishes live output, tool waits, empty replies and interrupted requests", () => {
  for (const [phase, status, body, expected] of [
    ["running", "pending", "partial answer", "请求中 · 请求处理中…"],
    ["waiting-tools", "success", "checking files", "等待工具回传…"],
    ["returned", "success", "", "请求已完成，未返回文本内容。"],
    ["failed", "failed", "", "请求失败，未收到返回内容。"],
    ["cancelled", "cancelled", "", "请求已取消，未收到返回内容。"]
  ] as const) {
    const log: RequestLog = { id: "one", createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", revision: 1,
      requestHeaders: {}, msg: ["analyse"], result: { status, statusCode: 0, body }, phase, calls: [], tools: [] };
    const html = renderToStaticMarkup(React.createElement(LogDetailModal, { log, loading: false, error: "", onClose() {}, onDelete() {} }));
    assert.ok(html.includes(expected), phase);
    assert.ok(!html.includes("自动更新"));
    const label = phase === "running" || phase === "waiting-tools" ? "当前结果" : "最终结果";
    assert.ok(html.includes(`aria-label="${label}"`), phase);
    if (body) assert.ok(html.includes(body), phase);
  }
});

test("request placeholders use explicit stages and do not infer downstream reception from missing attempts", () => {
  const cases: Array<[RequestLogStage | undefined, string, boolean]> = [
    ["receiving-request", "正在接收下游请求体…", false],
    ["preparing-upstream", "下游请求已接收，正在准备上游请求…", false],
    ["waiting-upstream", "正在请求上游，等待响应…", true],
    ["receiving-upstream", "已收到上游响应，正在接收内容…", true],
    ["waiting-retry", "上游请求未成功，等待重试…", false],
    ["forwarding-response", "正在向下游转发响应…", true],
    [undefined, "请求处理中…", false]
  ];
  for (const [stage, expected, withAttempt] of cases) {
    const createdAt = "2026-09-07T00:00:00.000Z";
    const result = { status: "pending" as const, stage, statusCode: 0, body: "" };
    const log: RequestLog = { id: "stages", createdAt, updatedAt: createdAt, revision: 1, requestHeaders: {}, msg: [], result, phase: "running", tools: [],
      calls: [{ id: "call", createdAt, updatedAt: createdAt, result, attempts: withAttempt
        ? [{ id: "attempt", createdAt, updatedAt: createdAt, upstream: { provider: "fixture", model: "model", url: "https://example.invalid/v1" }, result }]
        : [] }] };
    const html = renderToStaticMarkup(React.createElement(LogDetailModal, { log, loading: false, error: "", onClose() {}, onDelete() {} }));
    assert.ok(html.includes(expected), stage || "legacy logs have no recorded stage");
    const chain = html.slice(html.indexOf('<ol class="log-call-list">'));
    assert.ok(chain.includes(expected), "the call or attempt must use the same observed stage as the standalone result");
    assert.ok(!html.includes("正在接收请求，等待转发"));
    if (stage !== "receiving-request") assert.ok(!html.includes("正在接收下游请求体"));
  }
});

test("completed calls without upstream attempts never display a pending placeholder", () => {
  for (const status of ["success", "failed", "cancelled"] as const) {
    const createdAt = "2026-09-07T00:00:00.000Z";
    const result = { status, stage: "receiving-request" as const, statusCode: 0, body: "" };
    const log: RequestLog = { id: "finished", createdAt, updatedAt: createdAt, revision: 1, requestHeaders: {}, msg: [], result,
      phase: status === "success" ? "returned" : status, tools: [],
      calls: [{ id: "call", createdAt, updatedAt: createdAt, result, attempts: [] }] };
    const html = renderToStaticMarkup(React.createElement(LogDetailModal, { log, loading: false, error: "", onClose() {}, onDelete() {} }));
    assert.ok(!html.includes("正在接收"));
    assert.ok(!html.includes("等待转发"));
    assert.ok(!html.includes("请求处理中"));
  }
});

test("the current result retains the previous response while waiting and replaces it when new content arrives", () => {
  for (const previousStatus of ["success", "failed"] as const) for (const body of ["", "new partial answer"]) {
    const createdAt = "2026-09-07T00:00:00.000Z";
    const previousUpstream = { provider: "previous provider", model: "old-model", url: "https://previous.invalid/v1" };
    const upstream = { provider: "current provider", model: "new-model", url: "https://current.invalid/v1" };
    const previous = { id: "previous", createdAt, updatedAt: createdAt, upstream: previousUpstream,
      result: { status: previousStatus, statusCode: previousStatus === "success" ? 200 : 599, body: "previous result text" } };
    const result = { status: "pending" as const, stage: "waiting-upstream" as const, statusCode: 0, body };
    const current = { id: "current", createdAt, updatedAt: createdAt, upstream, result };
    const log: RequestLog = { id: "retain", createdAt, updatedAt: createdAt, revision: 1, requestHeaders: {}, msg: [], upstream, result,
      phase: "running", previousResultId: previous.id, tools: [], calls: previousStatus === "success"
        ? [{ ...previous, attempts: [previous] }, { ...current, attempts: [current] }]
        : [{ ...current, attempts: [previous, current] }] };
    const renderResult = () => {
      const html = renderToStaticMarkup(React.createElement(LogDetailModal, { log, loading: false, error: "", onClose() {}, onDelete() {} }));
      return html.match(/<section\b[^>]*class="[^"]*log-final-result[^"]*"[^>]*>([\s\S]*?)<\/section>/)![1];
    };
    const html = renderResult();
    const previousIndex = html.indexOf("previous result text");
    const pendingIndex = html.indexOf("请求中 · 正在请求上游，等待响应…");
    if (body) {
      assert.equal(previousIndex, -1, "new content replaces the previous response instead of appending to it");
      assert.ok(html.indexOf(body) >= 0 && html.indexOf(body) < pendingIndex);
    } else {
      assert.ok(previousIndex >= 0 && pendingIndex > previousIndex);
      assert.equal(html.match(/previous result text/g)?.length, 1);
    }
    assert.ok(!html.includes(previousUpstream.url));
    assert.ok(!html.includes(upstream.url));
    assert.ok(!html.includes("自动更新"));
    assert.equal(html.match(/role="status"/g)?.length, 1);
    log.phase = "returned";
    log.result = { status: "success", statusCode: 200, body: "new final answer" };
    const finished = renderResult();
    assert.ok(finished.includes("new final answer"));
    assert.ok(!finished.includes("previous result text"));
    assert.ok(!finished.includes("请求中 ·"));
  }
});

test("a previous local result without upstream attempts remains visible while the next call is pending", () => {
  const createdAt = "2026-09-07T00:00:00.000Z";
  const result = { status: "pending" as const, stage: "preparing-upstream" as const, statusCode: 0, body: "" };
  const log: RequestLog = { id: "local", createdAt, updatedAt: createdAt, revision: 1, requestHeaders: {}, msg: [], result,
    phase: "running", previousResultId: "previous-local", tools: [], calls: [
      { id: "previous-local", createdAt, updatedAt: createdAt, result: { status: "success", statusCode: 200, body: "previous local response" }, attempts: [] },
      { id: "current", createdAt, updatedAt: createdAt, result, attempts: [] }
    ] };
  const html = renderToStaticMarkup(React.createElement(LogDetailModal, { log, loading: false, error: "", onClose() {}, onDelete() {} }));
  const current = html.match(/<section\b[^>]*aria-label="当前结果"[^>]*>([\s\S]*?)<\/section>/)![1];
  assert.ok(current.indexOf("previous local response") < current.indexOf("请求中 ·"));
  assert.ok(current.includes("下游请求已接收，正在准备上游请求…"));
});

test("account snapshots remain in the log list and call chain but stay out of the standalone result", () => {
  const createdAt = "2026-09-07T00:00:00.000Z";
  const target = { provider: "fixture", model: "model", url: "https://example.invalid/v1" };
  const upstream = { ...target, account: { id: "second-account", label: '<img src=x onerror="alert(1)">' } };
  const result = { status: "pending" as const, stage: "waiting-upstream" as const, statusCode: 0, body: "" };
  const previous = { id: "first-attempt", createdAt, updatedAt: createdAt,
    upstream: { ...target, account: { id: "first-account", label: "first account" } },
    result: { status: "failed" as const, statusCode: 401, body: "first account rejected" } };
  const current = { id: "current", createdAt, updatedAt: createdAt, upstream, result };
  const log: RequestLog = { ...current, revision: 1, requestHeaders: {}, msg: ["hello"], phase: "running",
    previousResultId: previous.id, tools: [], calls: [{ ...current, attempts: [previous, current] }] };
  const html = renderToStaticMarkup(React.createElement(LogDetailModal, { log, loading: false, error: "", onClose() {}, onDelete() {} }));
  const standalone = html.match(/<section\b[^>]*aria-label="当前结果"[^>]*>([\s\S]*?)<\/section>/)![1];
  const pendingIndex = standalone.indexOf("请求中 ·");
  assert.ok(standalone.indexOf("first account rejected") >= 0 && standalone.indexOf("first account rejected") < pendingIndex);
  assert.ok(!standalone.includes("账号："));
  assert.ok(!standalone.includes(target.url));
  assert.ok(!standalone.includes("log-upstream-target"));
  const chain = html.slice(html.indexOf('<ol class="log-call-list">'));
  assert.ok(chain.includes("账号：first account"));
  assert.ok(chain.includes("账号：&lt;img"));
  assert.ok(!html.includes("<img"));

  const snapshot = { requestLogs: [{ ...log, msg: "hello", messageCount: 1, requestCount: 1, attemptCount: 2, toolCount: 0 }] } as unknown as AppSnapshot;
  const renderList = () => renderToStaticMarkup(React.createElement(LogsView, { snapshot, total: 1, pageSize: 20,
    autoRefresh: false, refreshing: false, loadingMore: false, selectedLogId: null,
    onAutoRefresh() {}, onLoadMore() {}, onOpenLog() {}, onCloseLog() {}, onDelete() {}, onClear() {}, onCopy() {} }));
  const list = renderList();
  assert.ok(list.includes("账号：&lt;img"));
  assert.ok(list.includes("second-account"));
  assert.ok(!list.includes("<img"));
  snapshot.requestLogs[0].upstream = target;
  assert.ok(renderList().includes("账号：未记录"));
});
