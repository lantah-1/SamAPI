import type {
  AppSnapshot,
  GroupRoute,
  GroupRouteMember,
  RequestLog,
  RouteProxyConfig,
  RouteRecord,
  RouteType,
  Site,
  TemporaryAccount,
  TemporaryAccountAvailability,
  TemporaryAccountCheckResult
} from "../../shared/types";
import { blankAddress, blankHeaderRow } from "./constants";
import type {
  HeaderKeyValue,
  HeaderTemplateDraft,
  ProviderApiKeyDraft,
  ProviderKeyGroupDraft,
  ProviderModelOption,
  RouteDraft,
  TemporaryAccountImportDraft
} from "./types";

export function groupMemberKey(member: GroupRouteMember) {
  return `${member.siteId}::${member.apiKeyId}::${member.model}`;
}

export function providerModelOptions(snapshot?: AppSnapshot): ProviderModelOption[] {
  if (!snapshot) return [];
  const options = new globalThis.Map<string, ProviderModelOption>();
  for (const group of snapshot.providerApiKeyGroups) {
    const site = snapshot.sites.find((item) => item.id === group.siteId);
    for (const apiKey of group.apiKeys) {
      for (const model of apiKey.models) {
        if (!model) continue;
        const option = {
          siteId: group.siteId,
          siteName: site?.name || group.groupName,
          apiKeyId: apiKey.id,
          apiKeyLabel: apiKey.label,
          model,
          enabled: Boolean(apiKey.enabled && site && site.enabled !== false)
        };
        options.set(groupMemberKey(option), option);
      }
    }
  }
  return Array.from(options.values()).sort((left, right) => {
    const siteOrder = left.siteName.localeCompare(right.siteName);
    if (siteOrder !== 0) return siteOrder;
    const keyOrder = left.apiKeyLabel.localeCompare(right.apiKeyLabel);
    if (keyOrder !== 0) return keyOrder;
    return left.model.localeCompare(right.model);
  });
}

export function optionToMember(option: ProviderModelOption): GroupRouteMember {
  return {
    siteId: option.siteId,
    apiKeyId: option.apiKeyId,
    model: option.model
  };
}

export function uniqueMembers(members: GroupRouteMember[]) {
  const memberMap = new globalThis.Map<string, GroupRouteMember>();
  for (const member of members) memberMap.set(groupMemberKey(member), member);
  return Array.from(memberMap.values());
}

export function matchRuleTokens(rule: string) {
  return rule
    .split(/[\n,，;；]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

export function modelMatchesRule(model: string, rule: string) {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return false;
  return matchRuleTokens(rule).some((token) => normalizedModel.startsWith(token));
}

export function modelMatchTokens(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function smartModelMatches(model: string, query: string) {
  if (modelMatchesRule(model, query)) return true;
  const modelTokens = modelMatchTokens(model);
  const queryTokens = modelMatchTokens(query);
  if (modelTokens.length === 0 || queryTokens.length === 0) return false;
  const modelCounts = new globalThis.Map<string, number>();
  for (const token of modelTokens) modelCounts.set(token, (modelCounts.get(token) || 0) + 1);
  return queryTokens.every((token) => {
    const current = modelCounts.get(token) || 0;
    if (current <= 0) return false;
    modelCounts.set(token, current - 1);
    return true;
  });
}

export function groupRouteStats(snapshot: AppSnapshot, route: GroupRoute) {
  const selected = new Set((route.members || []).map(groupMemberKey));
  const selectedOptions = providerModelOptions(snapshot).filter((option) => selected.has(groupMemberKey(option)));
  return {
    providerCount: new Set(selectedOptions.map((option) => option.siteId)).size,
    keyCount: new Set(selectedOptions.map((option) => option.apiKeyId)).size,
    modelCount: selectedOptions.length
  };
}

export function groupRouteMemberGroups(snapshot: AppSnapshot, route: GroupRoute) {
  const selected = new Set((route.members || []).map(groupMemberKey));
  const providerMap = new globalThis.Map<
    string,
    {
      siteId: string;
      siteName: string;
      apiKeys: globalThis.Map<string, { apiKeyId: string; apiKeyLabel: string; models: string[] }>;
    }
  >();
  for (const option of providerModelOptions(snapshot)) {
    if (!selected.has(groupMemberKey(option))) continue;
    const provider =
      providerMap.get(option.siteId) ||
      {
        siteId: option.siteId,
        siteName: option.siteName,
        apiKeys: new globalThis.Map<string, { apiKeyId: string; apiKeyLabel: string; models: string[] }>()
      };
    const apiKey = provider.apiKeys.get(option.apiKeyId) || { apiKeyId: option.apiKeyId, apiKeyLabel: option.apiKeyLabel, models: [] };
    apiKey.models.push(option.model);
    provider.apiKeys.set(option.apiKeyId, apiKey);
    providerMap.set(option.siteId, provider);
  }
  return Array.from(providerMap.values()).map((provider) => ({
    ...provider,
    apiKeys: Array.from(provider.apiKeys.values())
  }));
}

export function groupRouteOrderedMembers(snapshot: AppSnapshot, route: GroupRoute) {
  const lookup = new globalThis.Map(providerModelOptions(snapshot).map((option) => [groupMemberKey(option), option] as const));
  return (route.members || []).map((member) => {
    const option = lookup.get(groupMemberKey(member));
    return {
      key: groupMemberKey(member),
      model: option?.model || member.model,
      siteName: option?.siteName || member.siteId,
      apiKeyLabel: option?.apiKeyLabel,
      resolved: Boolean(option)
    };
  });
}

export function emptyRoute(snapshot?: AppSnapshot, type: RouteType = "switch"): RouteDraft {
  if (type === "group") {
    return {
      name: "default-group",
      type: "group",
      matchRule: "",
      members: [],
      strategy: "stable-first",
      endpoint: "messages",
      headerTemplateId: snapshot?.headerTemplates[0]?.id,
      proxy: { mode: "direct" },
      enabled: true
    };
  }
  const site = snapshot?.sites[0];
  const models = site ? siteModels(site) : [];
  return {
    name: "default-messages",
    type: "switch",
    siteId: site?.id || "",
    model: models[0] || "",
    endpoint: "messages",
    headerTemplateId: snapshot?.headerTemplates[0]?.id,
    enabled: true
  };
}

export function siteModels(site?: Site) {
  if (!site) return [];
  return Array.from(new Set(site.addresses.filter((address) => address.enabled).flatMap((address) => address.models).filter(Boolean))).sort();
}

export function parseModelText(value: string) {
  return Array.from(new Set(value.split(/[\n,，;；\s]+/).map((model) => model.trim()).filter(Boolean))).sort();
}

export function serializeModelText(models: string[]) {
  return models.join("\n");
}

export function mergeModelOptions(...modelLists: Array<Array<string | undefined>>) {
  return Array.from(new Set(modelLists.flat().filter((model): model is string => Boolean(model)))).sort();
}

export function normalizedRouteProxy(proxy?: RouteProxyConfig): RouteProxyConfig {
  if (proxy?.mode === "system") return { mode: "system" };
  if (proxy?.mode === "custom") return { mode: "custom", url: proxy.url || "" };
  return { mode: "direct" };
}

export function routeProxyConfigsEqual(left?: RouteProxyConfig, right?: RouteProxyConfig) {
  const normalizedLeft = normalizedRouteProxy(left);
  const normalizedRight = normalizedRouteProxy(right);
  return (
    normalizedLeft.mode === normalizedRight.mode &&
    (normalizedLeft.mode !== "custom" || normalizedLeft.url === normalizedRight.url)
  );
}

export function emptySite(): Partial<Site> {
  return {
    name: "",
    siteType: "unknown",
    enabled: true,
    addresses: [{ ...blankAddress }]
  };
}

export function parseHeaderRows(headersText = ""): HeaderKeyValue[] {
  const rows = headersText
    .split(/\r?\n/)
    .map((rawLine) => rawLine.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex < 0) return { key: line, value: "" };
      return {
        key: line.slice(0, separatorIndex).trim(),
        value: line.slice(separatorIndex + 1).trim()
      };
    });
  return rows.length > 0 ? rows : [{ ...blankHeaderRow }];
}

export function serializeHeaderRows(rows: HeaderKeyValue[]) {
  return rows
    .map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
    .filter((row) => row.key)
    .map((row) => `${row.key}: ${row.value}`)
    .join("\n");
}

export function emptyHeader(): HeaderTemplateDraft {
  return {
    name: "",
    headersText: "",
    headerRows: [{ ...blankHeaderRow }]
  };
}

export function isOfficialOpenAiSite(site?: Site) {
  return Boolean(site?.addresses.some((address) => address.baseUrl.includes("api.openai.com")));
}

export function isOfficialGrokSite(site?: Site) {
  return Boolean(site?.addresses.some((address) => address.baseUrl.includes("api.x.ai")));
}

export function emptyProviderApiKey(site?: Site, index = 0): ProviderApiKeyDraft {
  if (isOfficialOpenAiSite(site)) {
    return { label: "ChatGPT 官方", secret: "", kind: "chatgpt-official", enabled: true, models: [] };
  }
  if (isOfficialGrokSite(site)) {
    return { label: "Grok 官方", secret: "", kind: "grok-official", enabled: true, models: [] };
  }
  return { label: `Key ${index + 1}`, secret: "", kind: "api-key", enabled: true, models: [] };
}

export function emptyProviderKeyGroup(snapshot?: AppSnapshot): ProviderKeyGroupDraft {
  const site = snapshot?.sites[0];
  return {
    siteId: site?.id || "",
    groupName: site?.name || "",
    apiKeys: [emptyProviderApiKey(site)]
  };
}

export function emptyTemporaryAccountImport(): TemporaryAccountImportDraft {
  return {
    name: "GPT 临时账号",
    providerType: "gpt",
    source: "subapi",
    mode: "auto",
    modelsText: "",
    content: "",
    contents: [],
    fileNames: []
  };
}

export function temporaryAccountCheckSummary(result: TemporaryAccountCheckResult) {
  return `${result.total} 个账号，${result.available} 可用 / ${result.unavailable} 不可用 / ${result.unknown} 未检查`;
}

export function temporaryAccountAvailabilityStats(accounts: TemporaryAccount[]) {
  return accounts.reduce(
    (stats, account) => {
      const availability = account.availability || "unknown";
      stats[availability] += 1;
      return stats;
    },
    { available: 0, unavailable: 0, unknown: 0 } satisfies Record<TemporaryAccountAvailability, number>
  );
}

export function temporaryAccountTypeLabel(account: TemporaryAccount) {
  if (account.accountType === "openai-api-key") return "OpenAI API Key";
  if (account.providerType === "grok") {
    return account.grokOAuthFormat === "grok2api-oauth" ? "Grok OAuth / grok2api" : "Grok OAuth / CPA";
  }
  if (account.accountType === "codex" || account.accountId) return "Codex";
  return "临时账号";
}

export function formatQuotaValue(value: TemporaryAccount["quotaStages"][number]["remaining"], unit?: string) {
  if (value === undefined || value === null || value === "") return "";
  return `${value}${unit || ""}`;
}

export function temporaryAccountQuotaText(stage: TemporaryAccount["quotaStages"][number]) {
  const parts = [
    formatQuotaValue(stage.remaining, stage.unit) ? `剩余 ${formatQuotaValue(stage.remaining, stage.unit)}` : "",
    formatQuotaValue(stage.used, stage.unit) ? `已用 ${formatQuotaValue(stage.used, stage.unit)}` : "",
    formatQuotaValue(stage.total, stage.unit) ? `总量 ${formatQuotaValue(stage.total, stage.unit)}` : "",
    stage.resetAt ? `${formatTime(stage.resetAt)} 重置` : ""
  ].filter(Boolean);
  return `${stage.label}${parts.length > 0 ? `：${parts.join(" / ")}` : ""}`;
}

export function numericQuotaValue(value: TemporaryAccount["quotaStages"][number]["remaining"]) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = Number(value.replace(/,/g, "").replace(/%$/, "").trim());
  return Number.isFinite(normalized) ? normalized : undefined;
}

export function temporaryAccountQuotaPercent(stage: TemporaryAccount["quotaStages"][number]) {
  const remaining = numericQuotaValue(stage.remaining);
  const used = numericQuotaValue(stage.used);
  const total = numericQuotaValue(stage.total);
  if (total && total > 0 && remaining != null) return Math.min(100, Math.max(0, (remaining / total) * 100));
  if (total && total > 0 && used != null) return Math.min(100, Math.max(0, ((total - used) / total) * 100));
  if (remaining != null) return remaining > 0 ? 100 : 0;
  return undefined;
}

export function formatQuotaPercent(value?: number) {
  if (value == null) return "未知";
  return `${Math.round(value)}%`;
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

export function prettyJson(value: unknown) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function upstreamAttemptsSummary(log: RequestLog) {
  return (log.upstreamAttempts || []).map(({ requestBody: _requestBody, ...attempt }) => attempt);
}

export function upstreamRequestBodies(log: RequestLog) {
  const bodies = (log.upstreamAttempts || [])
    .filter((attempt) => attempt.requestBody !== undefined)
    .map((attempt) => ({
      addressLabel: attempt.addressLabel,
      upstreamUrl: attempt.upstreamUrl,
      model: attempt.model,
      endpoint: attempt.endpoint,
      body: attempt.requestBody
    }));
  return bodies.length > 0 ? bodies : "-";
}

export function apiOrigin() {
  const hostname = window.location.hostname || "127.0.0.1";
  return `http://${hostname}:8787`;
}

export function toastDurationMs(message: string) {
  return Math.min(12000, Math.max(3500, message.length * 45));
}

export function routeDisplayName(route: RouteRecord) {
  return route.name;
}
