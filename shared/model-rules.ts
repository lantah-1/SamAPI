import type { AppDatabase, DownstreamModelRule, ModelRuleCondition } from "./types.js";

type RequestHeaders = Record<string, string | string[] | undefined>;
type ModelRuleTargets = Pick<AppDatabase, "routes" | "sites" | "providerApiKeyGroups" | "headerTemplates" | "temporaryAccountGroups">;

export const PROJECT_PATH_HEADER = "x-samapi-project-path";
export const PROJECT_NAME_HEADER = "x-samapi-project-name";
export const DOWNSTREAM_PROJECT_HEADERS = [PROJECT_PATH_HEADER, PROJECT_NAME_HEADER, "x-samapi-project"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function officialOpenAiSite(site: ModelRuleTargets["sites"][number]) {
  return site.addresses.some((address) => {
    try {
      return new URL(address.baseUrl).hostname.toLowerCase() === "api.openai.com";
    } catch {
      return false;
    }
  });
}

export function normalizeDownstreamModelRules(value: unknown): DownstreamModelRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("下游模型映射必须是规则列表");
  const ids = new Set<string>();
  return value.map((item, index) => {
    const label = `第 ${index + 1} 条模型映射`;
    if (!record(item)) throw new Error(`${label}格式无效`);
    const id = text(item.id);
    if (!id || ids.has(id)) throw new Error(`${label}的标识为空或重复`);
    ids.add(id);
    const name = text(item.name);
    const model = text(item.model);
    const targetRouteId = text(item.targetRouteId);
    const targetSiteId = text(item.targetSiteId);
    const targetModel = text(item.targetModel);
    const headerTemplateId = text(item.headerTemplateId);
    const temporaryAccountId = text(item.temporaryAccountId);
    if (!name) throw new Error(`${label}需要填写规则名称`);
    if (!model) throw new Error(`${label}需要填写下游模型名`);
    if (targetRouteId && (targetSiteId || targetModel)) throw new Error(`${label}不能同时指定目标路由和供应商模型`);
    if (targetRouteId && headerTemplateId) throw new Error(`${label}使用目标路由时不能另选请求头模版`);
    if (targetRouteId && temporaryAccountId) throw new Error(`${label}使用目标路由时不能指定账号`);
    if (!targetRouteId && !targetSiteId) throw new Error(`${label}需要先选择目标供应商`);
    if (!targetRouteId && !targetModel) throw new Error(`${label}需要选择目标模型`);
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error(`${label}的启用状态无效`);
    if (!Array.isArray(item.conditions)) throw new Error(`${label}的匹配条件必须是列表`);
    const conditions = item.conditions.map((condition): ModelRuleCondition => {
      if (!record(condition) || !["header", "project"].includes(String(condition.source))) throw new Error(`${label}的匹配来源无效`);
      const match = condition.match;
      if (match !== "exact" && match !== "contains" && match !== "prefix") throw new Error(`${label}的匹配方式无效`);
      const value = text(condition.value);
      if (!value) throw new Error(`${label}的匹配内容不能为空`);
      if (condition.source === "project") return { source: "project", match, value };
      const header = text(condition.header).toLowerCase();
      if (!/^[!#$%&'*+.^_`|~\da-z-]+$/.test(header)) throw new Error(`${label}的请求头名称无效`);
      return { source: "header", header, match, value };
    });
    return {
      id, name, enabled: item.enabled !== false, model,
      ...(targetRouteId ? { targetRouteId } : { targetSiteId, targetModel, ...(headerTemplateId ? { headerTemplateId } : {}), ...(temporaryAccountId ? { temporaryAccountId } : {}) }),
      conditions
    };
  });
}

/** Only enabled keys contribute models; a model shared by several keys is listed once. */
export function modelRuleProviderModels(siteId: string, groups: ModelRuleTargets["providerApiKeyGroups"]): string[] {
  return [...new Set(groups.filter((group) => group.siteId === siteId)
    .flatMap((group) => group.apiKeys.filter((key) => key.enabled).flatMap((key) => key.models))
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function modelRuleTargetAvailable(rule: DownstreamModelRule, targets: ModelRuleTargets): boolean {
  if (rule.targetRouteId) return targets.routes.some((route) => route.id === rule.targetRouteId && route.enabled);
  const site = targets.sites.find((site) => site.id === rule.targetSiteId);
  if (!site?.enabled || !site.addresses.some((address) => address.enabled)) return false;
  if (rule.temporaryAccountId) {
    const account = targets.temporaryAccountGroups
      .filter((group) => group.siteId === site.id && (group.providerType || "gpt") === "gpt" && group.enabled !== false)
      .flatMap((group) => group.accounts)
      .find((account) => account.id === rule.temporaryAccountId);
    if (!officialOpenAiSite(site) || !account || !account.enabled || account.availability === "unavailable" || (account.models.length > 0 && !account.models.includes(rule.targetModel || ""))) return false;
  }
  return Boolean(
    rule.targetModel && modelRuleProviderModels(site.id, targets.providerApiKeyGroups).includes(rule.targetModel)
    && (!rule.headerTemplateId || targets.headerTemplates.some((template) => template.id === rule.headerTemplateId)));
}

export function validateModelRuleTargets(rules: DownstreamModelRule[], targets: ModelRuleTargets) {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.targetRouteId) {
      if (!targets.routes.some((route) => route.id === rule.targetRouteId)) {
        throw new Error(`模型映射「${rule.name}」的目标路由不存在，请重新选择或停用规则`);
      }
    } else if (!modelRuleTargetAvailable(rule, targets)) {
      throw new Error(`模型映射「${rule.name}」的目标供应商或模型不可用（或请求头模版不存在），请重新选择或停用规则`);
    }
  }
}

function headerValues(headers: RequestHeaders, name: string): string[] {
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name.toLowerCase()).flatMap(([, value]) => value ?? []);
  return values.map((value) => {
    if ([PROJECT_PATH_HEADER, PROJECT_NAME_HEADER].includes(name.toLowerCase())) {
      try {
        // Clients can encode non-ASCII project names and paths for HTTP headers.
        value = decodeURIComponent(value);
      } catch {
        // Preserve literal percent signs in unencoded paths.
      }
    }
    return value.trim();
  }).filter(Boolean);
}

/** Use explicit routing metadata only; never infer a project from conversation text. */
export function downstreamProjects(headers: RequestHeaders): string[] {
  const paths = headerValues(headers, PROJECT_PATH_HEADER);
  if (paths.length) return [...new Set(paths)];
  const explicit = headerValues(headers, "x-samapi-project");
  if (explicit.length) return [...new Set(explicit)];
  const projects: string[] = [];
  for (const value of headerValues(headers, "x-codex-turn-metadata")) {
    try {
      const metadata: unknown = JSON.parse(value);
      if (!record(metadata)) continue;
      const workspaces = metadata.workspaces;
      if (record(workspaces)) projects.push(...Object.keys(workspaces).filter((path) => path.trim()));
      else if (Array.isArray(workspaces)) projects.push(...workspaces.filter((path): path is string => typeof path === "string" && Boolean(path.trim())));
    } catch {
      // Optional client metadata may be missing or malformed; it must not break forwarding.
    }
  }
  return [...new Set(projects)];
}

function projectPath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function conditionMatches(condition: ModelRuleCondition, headers: RequestHeaders, projects: string[]) {
  const values = condition.source === "project" ? projects : headerValues(headers, condition.header);
  const normalize = condition.source === "project" ? projectPath : (value: string) => value.toLowerCase();
  const expected = normalize(condition.value);
  return values.some((value) => {
    const actual = normalize(value);
    if (condition.match === "exact") return actual === expected;
    if (condition.match === "contains") return actual.includes(expected);
    // Directory prefixes must not also match siblings such as /work/app-old.
    return condition.source === "project"
      ? actual === expected || actual.startsWith(expected.endsWith("/") ? expected : `${expected}/`)
      : actual.startsWith(expected);
  });
}

export function matchDownstreamModelRule(rules: DownstreamModelRule[], model: string, headers: RequestHeaders) {
  const candidates = rules.filter((rule) => rule.enabled && rule.model === model);
  if (!candidates.length) return undefined;
  const projects = candidates.some((rule) => rule.conditions.some((condition) => condition.source === "project")) ? downstreamProjects(headers) : [];
  return candidates.find((rule) => rule.conditions.every((condition) => conditionMatches(condition, headers, projects)));
}
