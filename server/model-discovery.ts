import http from "node:http";
import type { JsonStore } from "./store.js";
import {
  compactPreview,
  extractUpstreamError,
  maskRequestHeaders,
  maskSecret,
  responsePreview
} from "./util/text.js";
import { valueToHeaderText } from "./http.js";
import { modelEndpointCandidates, newApiPricingEndpointCandidates } from "./util/endpoints.js";
import { CHATGPT_MODELS_URL, CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL, fetchTemporaryAccountCheckText } from "./providers/constants.js";
import { codexQuotaHeaders, refreshCodexTemporaryAccountToken } from "./providers/codex.js";
import type { ProviderModelSyncResult, Site, SiteAddress } from "../shared/types.js";

export class ModelDiscoveryOptionsError extends Error {
  readonly modelGroups: Array<{ groupName: string; models: string[] }>;

  constructor(message: string, modelGroups: Array<{ groupName: string; models: string[] }>) {
    super(message);
    this.name = "ModelDiscoveryOptionsError";
    this.modelGroups = modelGroups;
  }
}


function newApiPricingHeaders(target: string) {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-store"
  };
  try {
    const parsed = new URL(target);
    headers.Referer = `${parsed.origin}/pricing`;
  } catch {
    // Keep the generic headers if URL parsing ever fails.
  }
  return headers;
}

function parseModelList(payload: unknown) {
  const source =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data?: unknown }).data
      : payload && typeof payload === "object" && "models" in payload
        ? (payload as { models?: unknown }).models
        : payload && typeof payload === "object" && "items" in payload
          ? (payload as { items?: unknown }).items
          : payload;
  if (!Array.isArray(source)) return [];
  return Array.from(
    new Set(
      source
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "id" in item) return String((item as { id?: unknown }).id || "");
          if (item && typeof item === "object" && "slug" in item) return String((item as { slug?: unknown }).slug || "");
          if (item && typeof item === "object" && "name" in item) return String((item as { name?: unknown }).name || "");
          return "";
        })
        .map((model) => model.trim())
        .filter(Boolean)
    )
  ).sort();
}

function newApiPriceSource(payload: unknown) {
  return payload && typeof payload === "object" && "data" in payload
    ? (payload as { data?: unknown }).data
    : payload;
}

function parseNewApiPriceGroups(payload: unknown) {
  const source = newApiPriceSource(payload);
  if (!Array.isArray(source)) return [];
  const groups = new Map<string, Set<string>>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const modelName = "model_name" in item ? (item as { model_name?: unknown }).model_name : undefined;
    const normalizedModel = typeof modelName === "string" ? modelName.trim() : "";
    if (!normalizedModel) continue;
    const enableGroups = "enable_groups" in item ? (item as { enable_groups?: unknown }).enable_groups : [];
    if (!Array.isArray(enableGroups)) continue;
    for (const group of enableGroups) {
      const groupName = typeof group === "string" ? group.trim() : "";
      if (!groupName) continue;
      const models = groups.get(groupName) || new Set<string>();
      models.add(normalizedModel);
      groups.set(groupName, models);
    }
  }
  return Array.from(groups.entries())
    .map(([groupName, models]) => ({ groupName, models: Array.from(models).sort() }))
    .sort((left, right) => left.groupName.localeCompare(right.groupName));
}

function parseNewApiPriceModels(payload: unknown, apiKeyName: string) {
  return parseNewApiPriceGroups(payload).find((group) => group.groupName === apiKeyName)?.models || [];
}


export function createModelDiscovery(store: JsonStore) {
  function recordModelDiscoveryLog(input: {
    request: http.IncomingMessage;
    siteId: string;
    site?: Site;
    address?: SiteAddress;
    target?: string;
    apiKeyValue: string;
    apiKeyName?: string;
    discoveryType?: string;
    status: "success" | "failed";
    statusCode: number;
    startedAt: number;
    contentType?: string;
    responseText?: string;
    models?: string[];
    errorMessage?: string;
    usesApiKey?: boolean;
  }) {
    const maskedApiKey = maskSecret(input.apiKeyValue);
    const responsePreviewText =
      input.responseText ||
      (input.models
        ? JSON.stringify({ modelCount: input.models.length, models: input.models.slice(0, 80) }, null, 2)
        : undefined);

    store.recordRequestLog({
      routeName: "获取模型",
      method: input.request.method || "POST",
      path: "/api/provider-key-groups/discover-models",
      providerName: input.site?.name || "未选择供应商",
      providerId: input.site?.id,
      addressLabel: input.address?.label,
      model: input.models ? `模型发现：${input.models.length} 个模型` : "模型发现",
      userAgent: valueToHeaderText(input.request.headers["user-agent"]),
      clientIp: input.request.socket.remoteAddress || "",
      status: input.status,
      statusCode: input.statusCode,
      durationMs: Math.max(0, Date.now() - input.startedAt),
      requestHeaders: {
        ...maskRequestHeaders(input.request.headers),
        "upstream-accept": "application/json",
        ...(input.usesApiKey !== false && maskedApiKey ? { "upstream-authorization": `Bearer ${maskedApiKey}` } : {})
      },
      requestBody: {
        siteId: input.siteId || undefined,
        siteName: input.site?.name,
        siteType: input.site?.siteType || "unknown",
        discoveryType: input.discoveryType || "openai-models",
        addressId: input.address?.id,
        addressLabel: input.address?.label,
        target: input.target,
        apiKeyName: input.apiKeyName,
        apiKey: maskedApiKey || undefined
      },
      upstreamUrl: input.target,
      upstreamContentType: input.contentType,
      responsePreview: responsePreviewText ? responsePreview(responsePreviewText) : undefined,
      errorMessage: input.errorMessage
    });
  }

  async function discoverChatGptOfficialModels(siteId: string, site: Site, request: http.IncomingMessage, discoveryStartedAt: number) {
    const account = store.resolveTemporaryOpenAiAccounts("")[0];
    if (!account) {
      recordModelDiscoveryLog({
        request,
        siteId,
        site,
        apiKeyValue: "",
        apiKeyName: CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL,
        discoveryType: "chatgpt-official-models",
        status: "failed",
        statusCode: 400,
        startedAt: discoveryStartedAt,
        errorMessage: "请先在临时账号页导入 GPT 官方账号"
      });
      throw new Error("请先在临时账号页导入 GPT 官方账号");
    }

    let accessToken = account.secret;
    let tokenPatch: Awaited<ReturnType<typeof refreshCodexTemporaryAccountToken>> | undefined;
    const fetchModels = () => fetchTemporaryAccountCheckText(CHATGPT_MODELS_URL, {
      headers: codexQuotaHeaders(account, accessToken)
    });
    let attempt = await fetchModels();
    if ([401, 403].includes(attempt.response.status) && account.refreshToken) {
      tokenPatch = await refreshCodexTemporaryAccountToken(account);
      if (tokenPatch?.secret) {
        accessToken = tokenPatch.secret;
        attempt = await fetchModels();
      }
    }
    if (tokenPatch) store.updateTemporaryAccountCheckResult(account.id, tokenPatch);

    const contentType = attempt.response.headers.get("content-type") || "";
    if (!attempt.response.ok) {
      const errorMessage = extractUpstreamError(attempt.text) || `HTTP ${attempt.response.status}`;
      recordModelDiscoveryLog({
        request,
        siteId,
        site,
        target: CHATGPT_MODELS_URL,
        apiKeyValue: "",
        apiKeyName: CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL,
        discoveryType: "chatgpt-official-models",
        status: "failed",
        statusCode: attempt.response.status,
        startedAt: discoveryStartedAt,
        contentType,
        responseText: attempt.text,
        errorMessage,
        usesApiKey: false
      });
      throw new Error(`ChatGPT 官方模型同步失败：${errorMessage}`);
    }

    let payload: unknown = {};
    try {
      payload = attempt.text ? JSON.parse(attempt.text) : {};
    } catch {
      const errorMessage = "返回内容不是合法 JSON";
      recordModelDiscoveryLog({
        request,
        siteId,
        site,
        target: CHATGPT_MODELS_URL,
        apiKeyValue: "",
        apiKeyName: CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL,
        discoveryType: "chatgpt-official-models",
        status: "failed",
        statusCode: attempt.response.status,
        startedAt: discoveryStartedAt,
        contentType,
        responseText: attempt.text,
        errorMessage,
        usesApiKey: false
      });
      throw new Error(errorMessage);
    }
    const models = parseModelList(payload);
    if (models.length === 0) throw new Error("ChatGPT 官方模型同步失败：未解析到模型列表");
    recordModelDiscoveryLog({
      request,
      siteId,
      site,
      target: CHATGPT_MODELS_URL,
      apiKeyValue: "",
      apiKeyName: CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL,
      discoveryType: "chatgpt-official-models",
      status: "success",
      statusCode: attempt.response.status,
      startedAt: discoveryStartedAt,
      contentType,
      responseText: attempt.text,
      models,
      usesApiKey: false
    });
    return { siteId, siteName: site.name, addressId: site.addresses[0]?.id || "", addressLabel: site.addresses[0]?.label || "官方 API", models };
  }

  async function discoverProviderModels(siteId: string, apiKey: string, apiKeyName: string, request: http.IncomingMessage, kind = "api-key") {
    const discoveryStartedAt = Date.now();
    const apiKeyValue = apiKey.trim();
    const apiKeyNameValue = apiKeyName.trim();
    const isChatGptOfficial = !apiKeyValue && (kind === "chatgpt-official" || store.isOfficialOpenAiSite(siteId));
    const isGrokOfficial = !apiKeyValue && (kind === "grok-official" || store.isOfficialGrokSite(siteId));
    if (!siteId) {
      recordModelDiscoveryLog({
        request,
        siteId,
        apiKeyValue,
        apiKeyName: apiKeyNameValue,
        status: "failed",
        statusCode: 400,
        startedAt: discoveryStartedAt,
        errorMessage: "请选择供应商"
      });
      throw new Error("请选择供应商");
    }
    const maskedApiKey = maskSecret(apiKeyValue);
    const site = store.getDb().sites.find((item) => item.id === siteId);
    if (isGrokOfficial) {
      const errorMessage = "Grok 官方模型请在上游密钥的模型列表中手动填写";
      recordModelDiscoveryLog({
        request,
        siteId,
        site,
        apiKeyValue,
        apiKeyName: apiKeyNameValue,
        discoveryType: "grok-official-manual",
        status: "failed",
        statusCode: 400,
        startedAt: discoveryStartedAt,
        errorMessage,
        usesApiKey: false
      });
      throw new Error(errorMessage);
    }
    if (!apiKeyValue && !isChatGptOfficial) {
      recordModelDiscoveryLog({
        request,
        siteId,
        site,
        apiKeyValue,
        apiKeyName: apiKeyNameValue,
        status: "failed",
        statusCode: 400,
        startedAt: discoveryStartedAt,
        errorMessage: "API Key 不能为空"
      });
      throw new Error("API Key 不能为空");
    }
    if (!site) {
      recordModelDiscoveryLog({
        request,
        siteId,
        apiKeyValue,
        apiKeyName: apiKeyNameValue,
        status: "failed",
        statusCode: 400,
        startedAt: discoveryStartedAt,
        errorMessage: "供应商不存在"
      });
      throw new Error("供应商不存在");
    }
    if (isChatGptOfficial) return discoverChatGptOfficialModels(siteId, site, request, discoveryStartedAt);

    const discoveryType = site.siteType === "newapi" ? "newapi-pricing" : "openai-models";
    if (site.siteType === "newapi" && !apiKeyNameValue) {
      recordModelDiscoveryLog({
        request,
        siteId,
        site,
        apiKeyValue,
        apiKeyName: apiKeyNameValue,
        discoveryType,
        status: "failed",
        statusCode: 400,
        startedAt: discoveryStartedAt,
        errorMessage: "NewApi 获取模型需要填写 API Key 名称，用于匹配 enable_groups"
      });
      throw new Error("NewApi 获取模型需要填写 API Key 名称，用于匹配 enable_groups");
    }
    const addresses = site.addresses.filter((item) => item.enabled);
    const candidates = addresses.length > 0 ? addresses : site.addresses;
    if (candidates.length === 0) {
      recordModelDiscoveryLog({
        request,
        siteId,
        site,
        apiKeyValue,
        apiKeyName: apiKeyNameValue,
        discoveryType,
        status: "failed",
        statusCode: 400,
        startedAt: discoveryStartedAt,
        errorMessage: "供应商地址不可用"
      });
      throw new Error("供应商地址不可用");
    }

    const errors: string[] = [];
    for (const address of candidates) {
      const targets =
        site.siteType === "newapi"
          ? [
              ...newApiPricingEndpointCandidates(address.baseUrl).map((target) => ({
                target,
                discoveryType: "newapi-pricing",
                usesApiKey: false
              })),
              ...modelEndpointCandidates(address.baseUrl).map((target) => ({
                target,
                discoveryType: "openai-models",
                usesApiKey: true
              }))
            ]
          : modelEndpointCandidates(address.baseUrl).map((target) => ({
              target,
              discoveryType: "openai-models",
              usesApiKey: true
            }));
      for (const targetEntry of targets) {
        const { target } = targetEntry;
        const attemptStartedAt = Date.now();
        try {
          const upstream = await fetch(target, {
            headers: targetEntry.usesApiKey
              ? {
                  Authorization: `Bearer ${apiKeyValue}`,
                  Accept: "application/json"
                }
              : newApiPricingHeaders(target)
          });
          const contentType = upstream.headers.get("content-type") || "";
          const text = await upstream.text();
          if (!upstream.ok) {
            const authHint =
              targetEntry.usesApiKey && [401, 403].includes(upstream.status)
                ? `（已携带 Authorization: Bearer ${maskedApiKey}）`
                : "";
            const upstreamMessage = extractUpstreamError(text);
            const errorMessage = `${upstream.status}${authHint}${upstreamMessage ? ` ${upstreamMessage}` : ""}`;
            errors.push(`${address.label} ${target}：${errorMessage}`);
            recordModelDiscoveryLog({
              request,
              siteId,
              site,
              address,
              target,
              apiKeyValue,
              apiKeyName: apiKeyNameValue,
              discoveryType: targetEntry.discoveryType,
              status: "failed",
              statusCode: upstream.status,
              startedAt: attemptStartedAt,
              contentType,
              responseText: text,
              errorMessage,
              usesApiKey: targetEntry.usesApiKey
            });
            continue;
          }
          const preview = compactPreview(text);
          if (text && !contentType.includes("application/json") && /^\s*</.test(text)) {
            const errorMessage = "返回了 HTML 页面，请检查站点地址是否为 API Base URL";
            errors.push(`${address.label} ${target}：${errorMessage}`);
            recordModelDiscoveryLog({
              request,
              siteId,
              site,
              address,
              target,
              apiKeyValue,
              apiKeyName: apiKeyNameValue,
              discoveryType: targetEntry.discoveryType,
              status: "failed",
              statusCode: upstream.status,
              startedAt: attemptStartedAt,
              contentType,
              responseText: text,
              errorMessage,
              usesApiKey: targetEntry.usesApiKey
            });
            continue;
          }
          let payload: unknown = {};
          try {
            payload = text ? JSON.parse(text) : {};
          } catch {
            const errorMessage = `返回内容不是合法 JSON${preview ? `（${preview}` : ""}${preview ? "）" : ""}`;
            errors.push(`${address.label} ${target}：${errorMessage}`);
            recordModelDiscoveryLog({
              request,
              siteId,
              site,
              address,
              target,
              apiKeyValue,
              apiKeyName: apiKeyNameValue,
              discoveryType: targetEntry.discoveryType,
              status: "failed",
              statusCode: upstream.status,
              startedAt: attemptStartedAt,
              contentType,
              responseText: text,
              errorMessage,
              usesApiKey: targetEntry.usesApiKey
            });
            continue;
          }
          const models = parseModelList(payload);
          const modelGroups = targetEntry.discoveryType === "newapi-pricing" ? parseNewApiPriceGroups(payload) : [];
          const resolvedModels =
            targetEntry.discoveryType === "newapi-pricing"
              ? modelGroups.find((group) => group.groupName === apiKeyNameValue)?.models || []
              : models;
          if (resolvedModels.length === 0) {
            const errorMessage =
              targetEntry.discoveryType === "newapi-pricing"
                ? `未在 enable_groups 中匹配到 API Key 名称「${apiKeyNameValue}」的可用模型`
                : "未解析到模型列表";
            errors.push(`${address.label} ${target}：${errorMessage}`);
            recordModelDiscoveryLog({
              request,
              siteId,
              site,
              address,
              target,
              apiKeyValue,
              apiKeyName: apiKeyNameValue,
              discoveryType: targetEntry.discoveryType,
              status: "failed",
              statusCode: upstream.status,
              startedAt: attemptStartedAt,
              contentType,
              responseText: text,
              errorMessage,
              usesApiKey: targetEntry.usesApiKey
            });
            if (targetEntry.discoveryType === "newapi-pricing" && modelGroups.length > 0) {
              throw new ModelDiscoveryOptionsError(errorMessage, modelGroups);
            }
            continue;
          }
          recordModelDiscoveryLog({
            request,
            siteId,
            site,
            address,
            target,
            apiKeyValue,
            apiKeyName: apiKeyNameValue,
            discoveryType: targetEntry.discoveryType,
            status: "success",
            statusCode: upstream.status,
            startedAt: attemptStartedAt,
            contentType,
            responseText: text,
            models: resolvedModels,
            usesApiKey: targetEntry.usesApiKey
          });
          return { siteId, siteName: site.name, addressId: address.id, addressLabel: address.label, models: resolvedModels };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "请求失败";
          errors.push(`${address.label} ${target}：${errorMessage}`);
          recordModelDiscoveryLog({
            request,
            siteId,
            site,
            address,
            target,
            apiKeyValue,
            apiKeyName: apiKeyNameValue,
            discoveryType: targetEntry.discoveryType,
            status: "failed",
            statusCode: 599,
            startedAt: attemptStartedAt,
            errorMessage,
            usesApiKey: targetEntry.usesApiKey
          });
        }
      }
    }

    throw new Error(`模型列表获取失败：${errors.slice(0, 4).join("；") || "没有可用地址"}`);
  }

  async function syncAllProviderModels(request: http.IncomingMessage): Promise<ProviderModelSyncResult> {
    const db = store.getDb();
    const targets = db.providerApiKeyGroups.flatMap((group) => {
      const site = db.sites.find((item) => item.id === group.siteId);
      return group.apiKeys
        .filter((apiKey) => apiKey.enabled)
        .map((apiKey) => ({
          groupId: group.id,
          apiKeyId: apiKey.id,
          siteId: group.siteId,
          siteName: site?.name || group.groupName,
          apiKeyLabel: apiKey.label,
          secret: apiKey.secret,
          kind: apiKey.kind || "api-key",
          models: apiKey.models
        }));
    });
    const results: ProviderModelSyncResult["results"] = [];

    for (const target of targets) {
      if (target.kind === "grok-official") {
        results.push({
          groupId: target.groupId,
          apiKeyId: target.apiKeyId,
          siteId: target.siteId,
          siteName: target.siteName,
          apiKeyLabel: target.apiKeyLabel,
          status: "success",
          modelCount: target.models.length,
          models: target.models
        });
        continue;
      }
      try {
        const discovered = await discoverProviderModels(target.siteId, target.secret, target.apiKeyLabel, request, target.kind);
        const checkedAt = new Date().toISOString();
        store.updateProviderApiKeyModels(target.groupId, target.apiKeyId, discovered.models, checkedAt);
        results.push({
          groupId: target.groupId,
          apiKeyId: target.apiKeyId,
          siteId: target.siteId,
          siteName: discovered.siteName || target.siteName,
          apiKeyLabel: target.apiKeyLabel,
          status: "success",
          modelCount: discovered.models.length,
          models: discovered.models
        });
      } catch (error) {
        results.push({
          groupId: target.groupId,
          apiKeyId: target.apiKeyId,
          siteId: target.siteId,
          siteName: target.siteName,
          apiKeyLabel: target.apiKeyLabel,
          status: "failed",
          modelCount: 0,
          errorMessage: error instanceof Error ? error.message : "模型同步失败"
        });
      }
    }

    const success = results.filter((result) => result.status === "success").length;
    return {
      total: targets.length,
      success,
      failed: results.length - success,
      results
    };
  }


  return { discoverProviderModels, syncAllProviderModels };
}
