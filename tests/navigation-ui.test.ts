import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MainNavigation } from "../src/components/MainNavigation.js";

function navigationButtons(section: "accounts" | "usage") {
  const html = renderToStaticMarkup(React.createElement(MainNavigation, { section, onNavigate() {} }));
  return [...html.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/g)].map((match) => ({
    label: /title="([^"]+)"/.exec(match[1])?.[1],
    primary: /class="[^"]*\bmobile-primary-nav\b/.test(match[1]),
    current: /aria-current="page"/.test(match[1])
  }));
}

test("main navigation renders account management and consumption alongside every existing page", () => {
  const buttons = navigationButtons("accounts");
  assert.deepEqual(buttons.map((button) => button.label), [
    "路由管理", "站点管理", "密钥管理", "模型管理", "账号管理",
    "客户端密钥", "请求头模板", "请求日志", "消费统计", "接入指南"
  ]);
  assert.deepEqual(buttons.filter((button) => button.current).map((button) => button.label), ["账号管理"]);
  assert.deepEqual(navigationButtons("usage").filter((button) => button.current).map((button) => button.label), ["消费统计"]);
});

test("mobile navigation keeps accounts and consumption visible within four primary entries", () => {
  const primary = navigationButtons("usage").filter((button) => button.primary).map((button) => button.label);
  assert.deepEqual(primary, ["路由管理", "账号管理", "请求日志", "消费统计"]);
});
