import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DownstreamModelRulesEditor } from "../src/components/DownstreamModelRulesEditor.js";
import { SelectInput } from "../src/components/ui.js";
import type { DownstreamModelRule, ProviderApiKeyGroupView, Site, SwitchRoute, TemporaryAccountGroup } from "../shared/types.js";

test("project name conditions render as a dedicated source and do not require a custom header name", () => {
  const html = renderToStaticMarkup(React.createElement(DownstreamModelRulesEditor, {
    rules: [{ id: "project", name: "project", enabled: true, model: "alias", targetRouteId: "route", conditions: [
      { source: "header", header: "X-Samapi-Project-Name", match: "exact", value: "samapi" }
    ] }],
    routes: [], sites: [], providerApiKeyGroups: [], headerTemplates: [], disabled: false, error: "", onChange() {}
  }));
  assert.match(html, /项目名称/);
  assert.doesNotMatch(html, /model-rule-condition-custom/);
  assert.match(html, /placeholder="[^\"]*samapi"/);
});

const site = (id: string, patch: Partial<Site> = {}): Site => ({
  id, name: `供应商 ${id}`, siteType: "unknown", enabled: true, createdAt: "", updatedAt: "",
  addresses: [{ id: `address-${id}`, label: id, baseUrl: `https://${id}.invalid/v1`, enabled: true, models: [] }], ...patch
});
const group = (siteId: string): ProviderApiKeyGroupView => ({
  id: `group-${siteId}`, siteId, groupName: siteId, modelManageMode: "manual", createdAt: "", updatedAt: "",
  apiKeys: [
    { id: `${siteId}-1`, label: "first", prefix: "", secret: "", enabled: true, models: ["shared-model", `${siteId}-model`] },
    { id: `${siteId}-2`, label: "second", prefix: "", secret: "", enabled: true, models: ["shared-model"] },
    { id: `${siteId}-off`, label: "disabled", prefix: "", secret: "", enabled: false, models: [`${siteId}-disabled`] }
  ]
});
const newRule: DownstreamModelRule = { id: "rule", name: "rule", model: "alias", enabled: true, targetSiteId: "", targetModel: "", conditions: [] };
type EditorProps = Parameters<typeof DownstreamModelRulesEditor>[0];

function editor(patch: Partial<EditorProps> = {}) {
  const props: EditorProps = {
    rules: [newRule], routes: [], sites: [site("a"), site("b"), site("empty"), site("off", { enabled: false }), site("no-address", { addresses: [] })],
    providerApiKeyGroups: [group("a"), group("b")], headerTemplates: [], disabled: false, error: "", onChange(rules) { props.rules = rules; }, ...patch
  };
  const select = (label: string) => {
    let result: React.ReactElement<React.SelectHTMLAttributes<HTMLSelectElement>> | undefined;
    const visit = (node: React.ReactNode) => {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement<React.SelectHTMLAttributes<HTMLSelectElement>>(child)) return;
        if (child.type === SelectInput && child.props["aria-label"] === label) result = child;
        else visit(child.props.children);
      });
    };
    visit(DownstreamModelRulesEditor(props));
    assert.ok(result, `select ${label} must exist`);
    return result.props;
  };
  const options = (label: string) => React.Children.toArray(select(label).children)
    .filter((child): child is React.ReactElement<React.OptionHTMLAttributes<HTMLOptionElement>> => React.isValidElement(child))
    .map((child) => child.props);
  return {
    props, select, options,
    choose(label: string, value: string) { select(label).onChange?.({ target: { value } } as React.ChangeEvent<HTMLSelectElement>); },
    html() { return renderToStaticMarkup(React.createElement(DownstreamModelRulesEditor, props)); }
  };
}

test("mapping targets require a provider first and only list that provider's enabled, deduplicated models", () => {
  const view = editor();
  assert.equal(view.select("规则 1 目标模型").disabled, true);
  assert.match(view.html(), /请先选择供应商/);
  assert.match(view.html(), /1\. 供应商/);
  assert.match(view.html(), /2\. 目标模型/);
  assert.equal(view.options("规则 1 供应商").find((option) => option.value === "off")?.disabled, true);
  assert.equal(view.options("规则 1 供应商").find((option) => option.value === "no-address")?.disabled, true);
  view.choose("规则 1 供应商", "a");
  assert.equal(view.select("规则 1 目标模型").disabled, false);
  assert.deepEqual(view.options("规则 1 目标模型").map((option) => option.value), ["", "a-model", "shared-model"]);
  view.choose("规则 1 目标模型", "shared-model");
  assert.equal(view.props.rules[0].targetSiteId, "a");
  assert.equal(view.props.rules[0].targetModel, "shared-model");
  assert.equal(view.props.rules[0].targetRouteId, undefined);
  view.choose("规则 1 供应商", "b");
  assert.equal(view.props.rules[0].targetModel, "", "changing providers clears even a model both providers offer");
  assert.deepEqual(view.options("规则 1 目标模型").map((option) => option.value), ["", "b-model", "shared-model"]);
  view.choose("规则 1 供应商", "");
  assert.equal(view.select("规则 1 目标模型").disabled, true);
});

test("empty providers, deleted providers, unavailable models and busy state are explicit", () => {
  const view = editor();
  view.choose("规则 1 供应商", "empty");
  assert.equal(view.select("规则 1 目标模型").disabled, true);
  assert.match(view.html(), /该供应商暂无可用模型/);
  const missing = editor({ rules: [{ ...newRule, targetSiteId: "removed", targetModel: "original-model" }] });
  assert.match(missing.html(), /原供应商已删除/);
  assert.match(missing.html(), /original-model（已不可用）/);
  const unavailable = editor({ rules: [{ ...newRule, targetSiteId: "a", targetModel: "a-disabled" }] });
  assert.equal(unavailable.options("规则 1 目标模型").find((option) => option.value === "a-disabled")?.disabled, true);
  assert.match(unavailable.html(), /原目标模型已不可用/);
  const busy = editor({ rules: [{ ...newRule, targetSiteId: "a", targetModel: "a-model" }], disabled: true });
  assert.equal(busy.select("规则 1 供应商").disabled, true);
  assert.equal(busy.select("规则 1 目标模型").disabled, true);
});

test("legacy switch routes display their provider and model without silently replacing route settings", () => {
  const route: SwitchRoute = { id: "route", name: "original route", type: "switch", siteId: "a", model: "a-model", endpoint: "responses", headerTemplateId: "headers", enabled: true, createdAt: "", updatedAt: "" };
  const rule: DownstreamModelRule = { id: "legacy", name: "legacy", model: "alias", enabled: true, targetRouteId: route.id, conditions: [] };
  const view = editor({ rules: [rule], routes: [route] });
  assert.equal(view.select("规则 1 供应商").value, "a");
  assert.equal(view.select("规则 1 目标模型").value, "a-model");
  assert.deepEqual(view.props.rules, [rule]);
  assert.match(view.html(), /当前沿用路由「original route」的配置/);
  view.choose("规则 1 供应商", "a");
  view.choose("规则 1 目标模型", "a-model");
  assert.deepEqual(view.props.rules, [rule], "reselecting the current target preserves its route configuration");
  view.choose("规则 1 目标模型", "shared-model");
  assert.equal(view.props.rules[0].targetRouteId, undefined);
  assert.equal(view.props.rules[0].targetSiteId, "a");
  assert.equal(view.props.rules[0].targetModel, "shared-model");
  const unlisted = editor({ rules: [rule], routes: [{ ...route, model: "unlisted-model" }] });
  assert.match(unlisted.html(), /unlisted-model（原路由模型）/);
  assert.doesNotMatch(unlisted.html(), /原目标模型已不可用/);
});

test("legacy group and missing routes remain visible and can be replaced using the two-step selector", () => {
  const rule: DownstreamModelRule = { id: "legacy", name: "legacy", model: "alias", enabled: true, targetRouteId: "route", conditions: [] };
  const view = editor({ rules: [rule], routes: [{ id: "route", name: "group route", type: "group", strategy: "sequential", members: [], matchRule: "", endpoint: "responses", enabled: true, createdAt: "", updatedAt: "" }] });
  assert.match(view.html(), /group route · 分组路由/);
  assert.equal(view.select("规则 1 目标模型").disabled, true);
  view.choose("规则 1 供应商", "");
  assert.equal(view.props.rules[0].targetRouteId, undefined);
  view.choose("规则 1 供应商", "b");
  assert.equal(view.props.rules[0].targetModel, "");
  assert.equal(view.select("规则 1 目标模型").disabled, false);
  const missing = editor({ rules: [rule] });
  assert.match(missing.html(), /原目标路由已删除/);
  missing.choose("规则 1 供应商", "a");
  assert.equal(missing.props.rules[0].targetRouteId, undefined);
});

test("changing a rule provider does not change another rule's target", () => {
  const view = editor({ rules: [{ ...newRule, targetSiteId: "a", targetModel: "a-model" }, { ...newRule, id: "second", targetSiteId: "b", targetModel: "b-model" }] });
  view.choose("规则 1 供应商", "b");
  assert.equal(view.props.rules[0].targetModel, "");
  assert.equal(view.props.rules[1].targetModel, "b-model");
});

test("direct mappings can select an independent request-header template", () => {
  const view = editor({
    rules: [{ ...newRule, targetSiteId: "a", targetModel: "a-model" }],
    headerTemplates: [{ id: "headers", name: "Codex upstream", headersText: "Originator: codex", createdAt: "", updatedAt: "" }]
  });
  assert.deepEqual(view.options("规则 1 请求头模版").map((option) => option.value), ["", "headers"]);
  view.choose("规则 1 请求头模版", "headers");
  assert.equal(view.props.rules[0].headerTemplateId, "headers");
});

test("official OpenAI mappings expose a GPT account selector when multiple accounts exist", () => {
  const openAiSite = site("openai", { name: "OpenAI", addresses: [{ id: "openai-address", label: "official", baseUrl: "https://api.openai.com/v1", enabled: true, models: [] }] });
  const accounts = ["one", "two"].map((id) => ({ id: `account-${id}`, label: `GPT ${id}`, prefix: "", secret: "", enabled: true, models: ["shared-model"], quotaStages: [], importedAt: "", availability: "unknown" as const }));
  const temporaryAccountGroup = { id: "gpt-group", name: "GPT", source: "subapi", providerType: "gpt", siteId: openAiSite.id, enabled: true, accounts, createdAt: "", updatedAt: "" } as TemporaryAccountGroup;
  const view = editor({ sites: [openAiSite], providerApiKeyGroups: [group(openAiSite.id)], temporaryAccountGroups: [temporaryAccountGroup] });
  view.choose("规则 1 供应商", openAiSite.id);
  view.choose("规则 1 目标模型", "shared-model");
  assert.equal(view.select("规则 1 GPT 账号").disabled, false);
  assert.deepEqual(view.options("规则 1 GPT 账号").map((option) => option.value), ["", "account-one", "account-two"]);
  view.choose("规则 1 GPT 账号", "account-two");
  assert.equal(view.props.rules[0].temporaryAccountId, "account-two");
});
