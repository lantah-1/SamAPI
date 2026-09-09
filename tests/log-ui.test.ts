import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LogDetailModal } from "../src/views/SystemViews.js";
import type { RequestLog } from "../shared/types.js";

test("turn details show one user input with ordered requests, retries and tool callbacks and escape their text", () => {
  const createdAt = "2026-09-07T00:00:00.000Z";
  const upstream = { provider: "fixture", model: "model", url: "https://example.invalid/v1" };
  const result = { status: "success" as const, statusCode: 200, body: "actual reply\nsecond line" };
  const html = renderToStaticMarkup(React.createElement(LogDetailModal, {
    log: {
      id: "log-test", createdAt, updatedAt: createdAt, revision: 1, requestHeaders: { authorization: "***" },
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
  const chain = html.match(/<details\b[^>]*class="[^"]*log-call-chain[^"]*"[^>]*>/);
  assert.ok(chain);
  assert.doesNotMatch(chain[0], /\bopen(?:=|\s|>)/, "the call chain is collapsed by default");
  const finalResult = html.match(/<section\b[^>]*aria-label="最终结果"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(finalResult);
  assert.ok(finalResult[1].includes("actual reply\nsecond line"));
  assert.ok(finalResult[1].includes("https://example.invalid/v1"));
  assert.ok(!finalResult[1].includes("retry error"));
  assert.ok(html.indexOf(finalResult[0]) < html.indexOf(chain[0]), "the final result is visible outside and before the collapsed chain");
});

test("the standalone result distinguishes live output, tool waits, empty replies and interrupted requests", () => {
  for (const [phase, status, body, expected] of [
    ["running", "pending", "partial answer", "内容随接口返回自动更新。"],
    ["waiting-tools", "success", "checking files", "等待工具回传，后续结果会自动更新。"],
    ["returned", "success", "", "上游未返回文本内容。"],
    ["failed", "failed", "", "请求失败，未收到返回内容。"],
    ["cancelled", "cancelled", "", "请求已取消，未收到返回内容。"]
  ] as const) {
    const log: RequestLog = { id: "one", createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", revision: 1,
      requestHeaders: {}, msg: ["analyse"], result: { status, statusCode: 0, body }, phase, calls: [], tools: [] };
    const html = renderToStaticMarkup(React.createElement(LogDetailModal, { log, loading: false, error: "", onClose() {}, onDelete() {} }));
    assert.ok(html.includes(expected), phase);
    const label = phase === "running" || phase === "waiting-tools" ? "当前结果" : "最终结果";
    assert.ok(html.includes(`aria-label="${label}"`), phase);
    if (body) assert.ok(html.includes(body), phase);
  }
});
