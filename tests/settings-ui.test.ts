import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import type { AppBackup, AppSnapshot } from "../shared/types.js";
import { SettingsDetailPage, SettingsView, settingsEntries } from "../src/views/SettingsView.js";
import { numericSettingUpdate, numericSettings, retryDelaySetting, retrySettingEntry, validatePasswordChange } from "../src/components/settings/GeneralSettingsDialogs.js";
import { parseSettingsBackup } from "../src/components/settings/BackupSettingsDialog.js";
import type { SettingsPageProps } from "../src/components/settings/types.js";

const snapshot: AppSnapshot = {
  sites: [], routes: [], routeDisplayGroups: [], providerApiKeyGroups: [], temporaryAccountGroups: [], headerTemplates: [], apiKeys: [], requestLogs: [],
  settings: { maxRequestLogs: 100, requestTimeoutSeconds: 60, adminSessionTtlMinutes: 30, themeId: "fresh", temporaryAccountStrategy: "sequential", upstreamRetryCodeCounts: [], upstreamRetryDelay: { mode: "random", minSeconds: 1, maxSeconds: 3 }, downstreamModelRules: [] },
  dbPath: "fixture", dataDir: "fixture", endpoints: ["messages", "responses", "chat/completions"], security: { adminPasswordCustomized: false }
};
const backup: AppBackup = {
  format: "samapi-backup", version: 1, exportedAt: "2026-09-16T00:00:00.000Z",
  data: { sites: [], routes: [], routeDisplayGroups: [], providerApiKeyGroups: [], temporaryAccountGroups: [], headerTemplates: [], apiKeys: [], settings: snapshot.settings }
};
const props: SettingsPageProps = {
  snapshot, busy: false, onClose() {}, async onSave() {}, async onPasswordChange() {}, async onExportBackup() { return backup; },
  async onImportBackup() { return { ok: true, importedAt: "", counts: { sites: 0, routes: 0, providerApiKeyGroups: 0, temporaryAccounts: 0, apiKeys: 0, headerTemplates: 0 } }; }
};

test("settings overview exposes all eight dialog entries without inline forms or model editing", () => {
  const html = renderToStaticMarkup(React.createElement(SettingsView, { ...props, onRefresh() {} }));
  const entries = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*aria-haspopup="dialog"/g)].map((match) => match[1]);
  assert.deepEqual(entries, settingsEntries.map((entry) => entry.title));
  assert.equal(entries.length, 8);
  assert.doesNotMatch(html, /<dialog|<form|<input|添加规则|保存设置/);
  for (const summary of ["尚未配置映射", "未启用重试", "60 秒", "最多 100 条", "清泉", "30 分钟"]) assert.ok(html.includes(summary));
});

test("each setting is its own named dialog with a close action and no unrelated settings forms", () => {
  for (const entry of settingsEntries) {
    const html = renderToStaticMarkup(React.createElement(SettingsDetailPage, { ...props, page: entry.id }));
    assert.equal([...html.matchAll(/<dialog\b/g)].length, 1, entry.title);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="[^"]+"/);
    assert.ok(html.includes(`aria-label="关闭${entry.title}"`));
    if (entry.id === "modelMapping") {
      assert.match(html, /添加规则/);
      assert.match(html, /保存映射/);
      assert.doesNotMatch(html, /当前密码|日志最多保留条数|导出备份/);
    } else {
      assert.doesNotMatch(html, /添加规则|下游请求模型/);
    }
    if (entry.id === "theme" || entry.id === "backup") assert.doesNotMatch(html, /type="submit"/);
    else assert.match(html, /type="submit"/);
  }
});

test("all settings dialogs use the shared header, scroll region and footer action group", () => {
  for (const entry of settingsEntries) {
    const $ = load(renderToStaticMarkup(React.createElement(SettingsDetailPage, { ...props, page: entry.id })));
    assert.equal($("dialog .settings-dialog-head .settings-dialog-close").length, 1, entry.title);
    assert.equal($("dialog .settings-dialog-body").length, 1, entry.title);
    assert.equal($("dialog .settings-dialog-footer").length, 1, entry.title);
    assert.equal($(".settings-dialog-footer .settings-dialog-note").length, 1, entry.title);
    assert.equal($(".settings-dialog-footer .settings-dialog-actions").length, 1, entry.title);
    assert.equal($(".settings-dialog-footer > button").length, 0, "actions must use the responsive action group");
  }
});

test("settings entries expose descriptions and current values alongside their accessible names", () => {
  const $ = load(renderToStaticMarkup(React.createElement(SettingsView, { ...props, onRefresh() {} })));
  for (const entry of settingsEntries) {
    const button = $(`.settings-entry[aria-label="${entry.title}"]`);
    const detailsId = button.attr("aria-describedby");
    assert.ok(detailsId, entry.title);
    const details = $(`[id="${detailsId}"]`);
    assert.ok(details.text().includes(entry.description));
    assert.ok(details.find(".settings-entry-value").text().trim());
  }
});

test("numeric settings and retry timing expose keypad modes and associated input guidance", () => {
  for (const setting of Object.keys(numericSettings) as Array<keyof typeof numericSettings>) {
    const $ = load(renderToStaticMarkup(React.createElement(SettingsDetailPage, { ...props, page: setting })));
    const input = $("input");
    assert.equal(input.attr("inputmode"), "numeric");
    assert.ok($(`[id="${input.attr("aria-describedby")}"]`).text().includes("可设置"));
  }
  const $ = load(renderToStaticMarkup(React.createElement(SettingsDetailPage, { ...props, page: "retries" })));
  assert.equal($('input[inputmode="numeric"]').length, 2);
  assert.equal($('input[inputmode="decimal"]').length, 2);
  for (const input of $('input[inputmode="decimal"]').toArray()) {
    const hint = $(`[id="${$(input).attr("aria-describedby")}"]`);
    assert.ok(hint.text().includes("最短时间不能大于最长时间"));
  }
});

test("settings summaries show saved mapping, retry and security state", () => {
  const html = renderToStaticMarkup(React.createElement(SettingsView, {
    ...props, onRefresh() {}, snapshot: { ...snapshot, security: { adminPasswordCustomized: true }, settings: {
      ...snapshot.settings, themeId: "midnight", upstreamRetryCodeCounts: [{ statusCode: 599, count: 3 }],
      downstreamModelRules: [
        { id: "one", name: "one", enabled: true, model: "alias", targetSiteId: "site", targetModel: "model", conditions: [] },
        { id: "two", name: "two", enabled: false, model: "alias", targetRouteId: "route", conditions: [] }
      ]
    } }
  }));
  for (const summary of ["2 条规则 · 1 条启用", "1 个错误码", "深海夜", "已设置自定义密码"]) assert.ok(html.includes(summary));
});

test("numeric setting saves validate bounds and only include their own field", () => {
  for (const setting of Object.keys(numericSettings) as Array<keyof typeof numericSettings>) {
    assert.deepEqual(numericSettingUpdate(setting, "12"), { [setting]: 12 });
    for (const invalid of ["", " ", "0", "-1", "1.5", "NaN", String(numericSettings[setting].max + 1)]) {
      assert.throws(() => numericSettingUpdate(setting, invalid));
    }
    const html = renderToStaticMarkup(React.createElement(SettingsDetailPage, { ...props, page: setting }));
    assert.equal([...html.matchAll(/<input\b/g)].length, 1);
    assert.match(html, /required=""/);
  }
});

test("pending setting saves disable both fields and dialog actions", () => {
  const html = renderToStaticMarkup(React.createElement(SettingsDetailPage, { ...props, busy: true, page: "modelMapping" }));
  assert.match(html, /<fieldset disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /正在保存/);
  assert.ok([...html.matchAll(/<button([^>]*)>/g)].every((match) => match[1].includes("disabled")));
});

test("retry and password validation retain their original boundaries", () => {
  assert.deepEqual(retrySettingEntry("599", "0"), { statusCode: 599, count: 0 });
  assert.deepEqual(retrySettingEntry("502", "100"), { statusCode: 502, count: 100 });
  for (const pair of [["", "1"], ["399", "1"], ["600", "1"], ["500", ""], ["500", "-1"], ["500", "1.5"], ["500", "Infinity"]]) {
    assert.throws(() => retrySettingEntry(pair[0], pair[1]));
  }
  assert.throws(() => validatePasswordChange("", "next", "next"), /当前管理密码/);
  assert.throws(() => validatePasswordChange("current", "abc", "abc"), /至少需要 4 个字符/);
  assert.throws(() => validatePasswordChange("current", "next", "other"), /两次输入/);
  assert.doesNotThrow(() => validatePasswordChange("current", "next", "next"));
});

test("retry timing drafts validate only the selected mode and preserve millisecond precision", () => {
  const draft = { mode: "random" as const, seconds: "", minSeconds: "0.125", maxSeconds: "2.5" };
  assert.deepEqual(retryDelaySetting(draft), { mode: "random", minSeconds: 0.125, maxSeconds: 2.5 });
  assert.deepEqual(retryDelaySetting({ ...draft, mode: "immediate", minSeconds: "", maxSeconds: "" }), { mode: "immediate" });
  assert.deepEqual(retryDelaySetting({ ...draft, mode: "fixed", seconds: "1.001", minSeconds: "", maxSeconds: "" }), { mode: "fixed", seconds: 1.001 });
  for (const minSeconds of ["", " ", "-1", "3", "NaN", "0.0001"]) assert.throws(() => retryDelaySetting({ ...draft, minSeconds }));
  assert.throws(() => retryDelaySetting({ ...draft, maxSeconds: "3601" }));
  assert.throws(() => retryDelaySetting({ ...draft, mode: "fixed" }), /请填写重试间隔/);
});

test("retry settings render the saved mode with only its applicable time inputs", () => {
  for (const delay of [{ mode: "random", minSeconds: 2, maxSeconds: 8 }, { mode: "fixed", seconds: 1.5 }, { mode: "immediate" }] as const) {
    const html = renderToStaticMarkup(React.createElement(SettingsDetailPage, { ...props, page: "retries", snapshot: {
      ...snapshot, settings: { ...snapshot.settings, upstreamRetryDelay: delay }
    } }));
    assert.match(html, /重试时间规则/);
    assert.match(html, /首次请求不等待/);
    assert.equal(html.includes("最短等待时间（秒）"), delay.mode === "random");
    assert.equal(html.includes("最长等待时间（秒）"), delay.mode === "random");
    assert.equal(html.includes("重试间隔（秒）"), delay.mode === "fixed");
    if (delay.mode !== "immediate") assert.match(html, /step="0\.001"/);
  }
  const html = renderToStaticMarkup(React.createElement(SettingsView, { ...props, onRefresh() {} }));
  assert.match(html, /未启用重试 · 随机 1-3 秒/);
});

test("backup selection validates the file before entering the overwrite confirmation", () => {
  assert.deepEqual(parseSettingsBackup(JSON.stringify(backup)), backup);
  for (const invalid of ["null", "{}", "[]", "broken", JSON.stringify({ ...backup, version: 2 }), JSON.stringify({ ...backup, data: { ...backup.data, routes: null } }), JSON.stringify({ ...backup, data: { ...backup.data, temporaryAccountGroups: [{}] } })]) {
    assert.throws(() => parseSettingsBackup(invalid));
  }
});
