import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { downstreamProjects, matchDownstreamModelRule, normalizeDownstreamModelRules } from "../shared/model-rules.js";
import type { AppSettings, DownstreamModelRule, ModelRuleCondition } from "../shared/types.js";
import { JsonStore } from "../server/store/index.js";
import { forwardableRequestHeaders, stripDownstreamProjectHeaders } from "../server/util/text.js";

const rule = (id: string, conditions: ModelRuleCondition[], patch: Partial<DownstreamModelRule> = {}): DownstreamModelRule => ({
  id, name: id, enabled: true, model: "gpt-5.6-sol", targetRouteId: `route-${id}`, conditions, ...patch
});
const desktop: ModelRuleCondition = { source: "header", header: "originator", match: "exact", value: "Codex Desktop" };
const project: ModelRuleCondition = { source: "project", match: "prefix", value: "/work/project" };
const metadata = (workspaces: unknown) => JSON.stringify({ workspaces, turn_id: "fixture-turn" });

test("empty conditions match only the requested model and participate in normal rule priority", () => {
  const fallback = rule("default", []);
  const scoped = rule("desktop", [desktop]);
  assert.deepEqual(normalizeDownstreamModelRules([fallback]), [fallback]);
  assert.equal(matchDownstreamModelRule([scoped, fallback], "gpt-5.6-sol", {})?.id, "default");
  assert.equal(matchDownstreamModelRule([scoped, fallback], "gpt-5.6-sol", { originator: "Codex Desktop" })?.id, "desktop");
  assert.equal(matchDownstreamModelRule([fallback, scoped], "gpt-5.6-sol", { originator: "Codex Desktop" })?.id, "default");
  assert.equal(matchDownstreamModelRule([fallback], "another-model", {}), undefined);
  assert.equal(matchDownstreamModelRule([{ ...fallback, enabled: false }], "gpt-5.6-sol", {}), undefined);
});

test("rules combine client and project conditions, preserve priority, and skip disabled or other-model rules", () => {
  const projectRule = rule("project", [desktop, project]);
  const clientRule = rule("client", [desktop]);
  const rules = [rule("disabled", [desktop], { enabled: false }), projectRule, clientRule];
  const headers = { Originator: "CODEX DESKTOP", "X-Codex-Turn-Metadata": metadata({ "/work/project/subdir": {} }) };
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", headers)?.id, "project");
  assert.equal(matchDownstreamModelRule([clientRule, projectRule], "gpt-5.6-sol", headers)?.id, "client");
  assert.equal(matchDownstreamModelRule(rules, "another-model", headers), undefined);
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", { ...headers, Originator: "codex_cli_rs" }), undefined);
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", { Originator: "Codex Desktop" })?.id, "client");
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", { ...headers, "X-Codex-Turn-Metadata": metadata({ "/work/project-old": {} }) })?.id, "client");
});

test("project matching reads actual Codex workspace maps, respects path case and explicit project overrides", () => {
  const headers = { "x-codex-turn-metadata": metadata({ "/work/project": { associated_remote_urls: { origin: "git@example.invalid:repo.git" } }, "/work/second": {} }) };
  assert.deepEqual(downstreamProjects(headers), ["/work/project", "/work/second"]);
  const rules = [rule("project", [project])];
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", headers)?.id, "project");
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", { "x-codex-turn-metadata": metadata(["/work/Project"]) }), undefined);
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", { "x-samapi-project": "/work/project/" })?.id, "project");
  assert.deepEqual(downstreamProjects({ ...headers, "X-Samapi-Project": "billing" }), ["billing"]);
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", { ...headers, "X-Samapi-Project": "billing" }), undefined);
  assert.equal(matchDownstreamModelRule([rule("windows", [{ source: "project", match: "prefix", value: "C:\\work\\project" }])], "gpt-5.6-sol", { "x-samapi-project": "C:\\work\\project\\src" })?.id, "windows");
});

test("missing or malformed metadata never matches a project or crashes unrelated header rules", () => {
  for (const value of [undefined, "{broken", "null", "[]", "{}", '{"workspaces":null}', '{"workspaces":[null,{}]}']) {
    const headers = { originator: "Codex Desktop", "x-codex-turn-metadata": value };
    assert.deepEqual(downstreamProjects(headers), []);
    assert.equal(matchDownstreamModelRule([rule("project", [project]), rule("client", [desktop])], "gpt-5.6-sol", headers)?.id, "client");
  }
});

test("explicit project paths take priority over legacy identifiers and workspace metadata, but names are separate", () => {
  const headers = {
    "X-Samapi-Project-Path": [" /work/project/subdir ", "/work/project/subdir"],
    "X-Samapi-Project-Name": "project",
    "X-Samapi-Project": "legacy",
    "x-codex-turn-metadata": metadata({ "/work/other": {} })
  };
  assert.deepEqual(downstreamProjects(headers), ["/work/project/subdir"]);
  assert.equal(matchDownstreamModelRule([rule("path", [project])], "gpt-5.6-sol", headers)?.id, "path");
  assert.deepEqual(downstreamProjects({ ...headers, "X-Samapi-Project-Path": " " }), ["legacy"]);
  assert.deepEqual(downstreamProjects({ "X-Samapi-Project-Name": "/work/project" }), []);
  assert.equal(matchDownstreamModelRule([rule("path", [project])], "gpt-5.6-sol", { "x-samapi-project-path": "/work/Project" }), undefined);
  assert.equal(matchDownstreamModelRule([rule("path", [project])], "gpt-5.6-sol", { "x-samapi-project-path": "/work/project-other" }), undefined);
});

test("project name rules combine with directory rules and support encoded names and paths", () => {
  const rules = [rule("named", [
    { source: "project", match: "prefix", value: "/work/项目" },
    { source: "header", header: "X-Samapi-Project-Name", match: "exact", value: "项目 App" }
  ])];
  const headers = { "x-samapi-project-path": encodeURIComponent("/work/项目/src"), "x-samapi-project-name": encodeURIComponent("项目 APP") };
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", headers)?.id, "named");
  assert.equal(matchDownstreamModelRule(rules, "gpt-5.6-sol", { ...headers, "x-samapi-project-name": "other" }), undefined);
  assert.deepEqual(downstreamProjects({ "x-samapi-project-path": "/work/100%" }), ["/work/100%"]);
  assert.deepEqual(downstreamProjects({ "x-samapi-project-path": encodeURIComponent("/work/%2F") }), ["/work/%2F"]);
  const nameRule = rule("name", [{ source: "header", header: "x-samapi-project-name", match: "prefix", value: "APP" }]);
  assert.equal(matchDownstreamModelRule([nameRule], "gpt-5.6-sol", { "x-samapi-project-name": "app-server" })?.id, "name");
  assert.equal(matchDownstreamModelRule([nameRule], "gpt-5.6-sol", { "x-samapi-project-path": "/work/app-server" }), undefined);
});

test("outgoing project headers are stripped case-insensitively without changing original client headers", () => {
  const original = {
    "X-Samapi-Project-Path": "/work/project", "x-samapi-project-path": "/work/duplicate",
    "X-Samapi-Project-Name": "project", "X-SAMAPI-PROJECT-NAME": "duplicate",
    "X-Samapi-Project": "legacy", "x-samapi-project": "duplicate",
    "x-codex-turn-metadata": metadata({ "/work/project": {} }), "x-upstream-custom": "keep-me"
  };
  const snapshot = structuredClone(original);
  for (const outgoing of [{ ...original }, forwardableRequestHeaders(original)]) {
    stripDownstreamProjectHeaders(outgoing);
    assert.deepEqual(outgoing, { "x-codex-turn-metadata": original["x-codex-turn-metadata"], "x-upstream-custom": "keep-me" });
    stripDownstreamProjectHeaders(outgoing);
  }
  assert.deepEqual(original, snapshot);
});

test("header matching supports contains, prefix and multiple values without interpreting regular expressions", () => {
  assert.equal(matchDownstreamModelRule([rule("ua", [{ source: "header", header: "user-agent", match: "contains", value: "CODEX CLI" }])], "gpt-5.6-sol", { "User-Agent": "client (Codex CLI; 1.0)" })?.id, "ua");
  assert.equal(matchDownstreamModelRule([rule("app", [{ source: "header", header: "x-app", match: "prefix", value: "cli/" }])], "gpt-5.6-sol", { "X-App": ["desktop", "CLI/2.0"] })?.id, "app");
  assert.equal(matchDownstreamModelRule([rule("literal", [{ source: "header", header: "x-app", match: "contains", value: ".*" }])], "gpt-5.6-sol", { "x-app": "desktop" }), undefined);
});

test("invalid rule edits fail explicitly instead of broadening conditions or silently discarding configuration", () => {
  assert.deepEqual(normalizeDownstreamModelRules(undefined), []);
  const valid = rule("valid", [desktop]);
  const normalized = normalizeDownstreamModelRules([{ ...valid, name: " rule ", model: " gpt-5.6-sol ", conditions: [{ ...desktop, header: " Originator " }] }]);
  assert.equal(normalized[0].name, "rule");
  assert.equal(normalized[0].model, "gpt-5.6-sol");
  assert.deepEqual(normalized[0].conditions, [desktop]);
  for (const invalid of [null, {}, [null], [valid, valid], [{ ...valid, enabled: "false" }], [{ ...valid, model: " " }], [{ ...valid, targetRouteId: "" }], [{ ...valid, conditions: undefined }], [{ ...valid, conditions: null }], [{ ...valid, conditions: {} }], [{ ...valid, conditions: [{ ...desktop, value: " " }] }], [{ ...valid, conditions: [{ ...desktop, header: "bad\nheader" }] }], [{ ...valid, conditions: [{ ...desktop, match: "regex" }] }]]) {
    assert.throws(() => normalizeDownstreamModelRules(invalid));
  }
});

test("model rules persist and survive backups; invalid edits and imports keep the previous configuration", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-model-rules-"));
  let store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(store.getDb().settings.downstreamModelRules, []);
  const site = store.upsertSite({ name: "fixture", addresses: [{ id: "address", label: "fixture", baseUrl: "https://fixture.invalid/v1", enabled: true, models: [] }] });
  const route = store.upsertRoute({ type: "switch", name: "target", siteId: site.id, model: "upstream-model", endpoint: "responses", enabled: true });
  const rules = [rule("project", [desktop, project], { targetRouteId: route.id }), rule("default", [], { targetRouteId: route.id })];
  store.updateSettings({ downstreamModelRules: rules });
  store.close();
  store = new JsonStore(dir);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, rules);
  assert.throws(() => store.updateSettings({ downstreamModelRules: [{ ...rules[0], targetRouteId: "missing" }] }), /目标路由不存在/);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, rules);
  const backup = store.exportBackup();
  const invalidBackup = structuredClone(backup);
  invalidBackup.data.settings.downstreamModelRules[0].targetRouteId = "missing";
  assert.throws(() => store.importBackup(invalidBackup), /目标路由不存在/);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, rules);
  store.updateSettings({ downstreamModelRules: [] });
  store.importBackup(backup);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, rules);
  delete (backup.data.settings as Partial<AppSettings>).downstreamModelRules;
  store.importBackup(backup);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, []);
});
