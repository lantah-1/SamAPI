import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { modelRuleProviderModels, modelRuleTargetAvailable, normalizeDownstreamModelRules, validateModelRuleTargets } from "../shared/model-rules.js";
import type { DownstreamModelRule } from "../shared/types.js";
import { JsonStore } from "../server/store/index.js";
import { createRouting, modelRuleTargetRoute, proxyRouteConfigurationKey } from "../server/routing.js";

const directRule: DownstreamModelRule = { id: "direct", name: "direct", model: "alias", enabled: true, targetSiteId: "site", targetModel: "upstream-model", conditions: [] };

test("direct targets normalize and reject incomplete or ambiguous selections", () => {
  assert.deepEqual(normalizeDownstreamModelRules([{ ...directRule, targetSiteId: " site ", targetModel: " upstream-model " }]), [directRule]);
  assert.deepEqual(normalizeDownstreamModelRules([{ ...directRule, headerTemplateId: " headers " }]), [{ ...directRule, headerTemplateId: "headers" }]);
  assert.throws(() => normalizeDownstreamModelRules([{ ...directRule, targetSiteId: "" }]), /选择目标供应商/);
  assert.throws(() => normalizeDownstreamModelRules([{ ...directRule, targetModel: "" }]), /选择目标模型/);
  assert.throws(() => normalizeDownstreamModelRules([{ ...directRule, targetRouteId: "route" }]), /不能同时指定/);
  assert.throws(() => normalizeDownstreamModelRules([{ ...directRule, targetRouteId: "route", targetSiteId: undefined, targetModel: undefined, headerTemplateId: "headers" }]), /不能另选请求头模版/);
  assert.throws(() => normalizeDownstreamModelRules([{ ...directRule, targetRouteId: "route", targetSiteId: undefined, targetModel: undefined, temporaryAccountId: "account" }]), /不能指定账号/);
});

test("official OpenAI mappings can pin one GPT account without changing the account pool", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-model-account-target-"));
  const store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = store.createManagedAccount({ provider: "gpt", label: "GPT one", secret: "sk-fixture-one", models: ["upstream-model"] });
  const second = store.createManagedAccount({ provider: "gpt", label: "GPT two", secret: "sk-fixture-two", models: ["upstream-model"] });
  const group = store.getDb().temporaryAccountGroups.find((item) => (item.providerType || "gpt") === "gpt")!;
  const rule = { ...directRule, targetSiteId: group.siteId, temporaryAccountId: second.id };
  assert.equal(modelRuleTargetAvailable(rule, store.getDb()), true);
  store.updateSettings({ downstreamModelRules: [rule] });
  const route = modelRuleTargetRoute(store.getDb(), rule)!;
  assert.equal(route.temporaryAccountId, second.id);
  const { candidates } = createRouting(store).resolveProxyExecution(route);
  assert.deepEqual(candidates.map((candidate) => candidate.temporaryApiKeyAccount?.id), [second.id]);
  assert.deepEqual(store.resolveTemporaryOpenAiAccounts("upstream-model").map((account) => account.id), [first.id, second.id]);
});

test("direct targets persist, survive backups, validate availability, and reuse routing without saved routes", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "samapi-model-targets-"));
  let store = new JsonStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const site = store.upsertSite({ name: "fixture", addresses: [{ id: "a", label: "fixture", baseUrl: "https://fixture.invalid/v1", enabled: true, models: [] }] });
  const group = store.upsertProviderApiKeyGroup({ siteId: site.id, apiKeys: [
    { label: "one", secret: "fixture-one", enabled: true, models: ["upstream-model", "shared-model"] },
    { label: "two", secret: "fixture-two", enabled: true, models: ["shared-model"] },
    { label: "disabled", secret: "fixture-off", enabled: false, models: ["unavailable-model"] }
  ] });
  const rule = { ...directRule, targetSiteId: site.id };
  const headerTemplate = store.upsertHeaderTemplate({ name: "direct headers", headersText: "X-Upstream: direct" });
  const routesBefore = structuredClone(store.getDb().routes);
  assert.deepEqual(modelRuleProviderModels(site.id, store.getDb().providerApiKeyGroups), ["shared-model", "upstream-model"]);
  assert.equal(modelRuleTargetAvailable(rule, store.getDb()), true);
  assert.equal(modelRuleTargetAvailable({ ...rule, headerTemplateId: headerTemplate.id }, store.getDb()), true);
  assert.equal(modelRuleTargetAvailable({ ...rule, headerTemplateId: "missing" }, store.getDb()), false);
  assert.equal(modelRuleTargetAvailable({ ...rule, targetModel: "unavailable-model" }, store.getDb()), false);
  store.updateSettings({ downstreamModelRules: [rule] });
  store.close();
  store = new JsonStore(dir);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, [rule]);
  const backup = store.exportBackup();
  store.updateSettings({ downstreamModelRules: [] });
  store.importBackup(backup);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, [rule]);
  assert.deepEqual(store.getDb().routes, routesBefore);

  const route = modelRuleTargetRoute(store.getDb(), rule, "responses")!;
  assert.equal(route.endpoint, "responses");
  const { candidates } = createRouting(store).resolveProxyExecution(route);
  assert.equal(candidates[0].site.id, site.id);
  assert.equal(candidates[0].model, "upstream-model");
  assert.equal(candidates[0].providerApiKey?.secret, "fixture-one");
  const headerRoute = modelRuleTargetRoute(store.getDb(), { ...rule, headerTemplateId: headerTemplate.id }, "responses")!;
  assert.equal(createRouting(store).resolveProxyExecution(headerRoute).candidates[0].headerTemplate?.id, headerTemplate.id);
  const configurationKey = proxyRouteConfigurationKey(store, route);
  store.upsertProviderApiKeyGroup({ ...group, apiKeys: group.apiKeys.map((key) => ({ ...key, enabled: false })) });
  assert.notEqual(proxyRouteConfigurationKey(store, route), configurationKey, "live provider changes invalidate direct-route retries");
  assert.equal(modelRuleTargetAvailable(rule, store.getDb()), false);
  assert.throws(() => store.updateSettings({ downstreamModelRules: [rule] }), /目标供应商或模型不可用/);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, [rule], "failed edits retain saved settings");
  assert.doesNotThrow(() => validateModelRuleTargets([{ ...rule, enabled: false }], store.getDb()));

  const invalidBackup = structuredClone(backup);
  invalidBackup.data.settings.downstreamModelRules[0].targetModel = "unavailable-model";
  assert.throws(() => store.importBackup(invalidBackup), /目标供应商或模型不可用/);
  assert.deepEqual(store.getDb().settings.downstreamModelRules, [rule]);
  store.importBackup(backup);
  store.upsertSite({ ...site, enabled: false });
  assert.equal(modelRuleTargetAvailable(rule, store.getDb()), false);
  store.upsertSite({ ...site, addresses: site.addresses.map((address) => ({ ...address, enabled: false })) });
  assert.equal(modelRuleTargetAvailable(rule, store.getDb()), false);
});
