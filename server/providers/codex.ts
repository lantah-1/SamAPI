import { randomBytes } from "node:crypto";
import {
  codexAccountIdFromIdToken,
  emailFromIdToken,
  extractUpstreamError,
  headerValue,
  isRecord,
  numberField,
  setHeader
} from "../util/text.js";
import { sseJsonObjectsFromReadable } from "../convert/stream.js";
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_ORIGINATOR,
  CODEX_USAGE_URL,
  CODEX_USER_AGENT,
  fetchTemporaryAccountCheckText
} from "./constants.js";
import type { RouteProxyConfig, TemporaryAccount, TemporaryAccountQuotaStage } from "../../shared/types.js";

interface CodexRateLimitWindowRecord {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
}

interface CodexRateLimitRecord {
  allowed?: unknown;
  limit_reached?: unknown;
  primary_window?: unknown;
  secondary_window?: unknown;
}


export async function refreshCodexTemporaryAccountToken(account: TemporaryAccount, proxyConfig?: RouteProxyConfig) {
  if (!account.refreshToken?.trim()) return undefined;
  const body = new URLSearchParams({
    client_id: CODEX_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: account.refreshToken.trim(),
    scope: "openid profile email"
  });
  const { response, text } = await fetchTemporaryAccountCheckText(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  }, proxyConfig);
  if (!response.ok) {
    const detail = extractUpstreamError(text) || "unknown_error";
    if (response.status === 400 && /invalid_grant/i.test(detail)) {
      throw new Error("刷新 Codex token 失败：refresh_token 已失效（invalid_grant），请重新导入该账号");
    }
    if ([401, 403].includes(response.status)) {
      throw new Error(`刷新 Codex token 失败：授权已失效（HTTP ${response.status} ${detail}），请重新导入该账号`);
    }
    throw new Error(`刷新 Codex token 失败：HTTP ${response.status} ${detail}`);
  }
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) throw new Error("刷新 Codex token 失败：响应缺少 access_token");
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim() ? payload.refresh_token.trim() : undefined;
  const idToken = typeof payload.id_token === "string" && payload.id_token.trim() ? payload.id_token.trim() : undefined;
  return {
    secret: accessToken,
    refreshToken,
    idToken,
    accountId: codexAccountIdFromIdToken(idToken) || account.accountId,
    email: emailFromIdToken(idToken) || account.email
  };
}

export function codexQuotaHeaders(account: TemporaryAccount, accessToken = account.secret) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "OpenAI-Beta": "codex-1",
    "OAI-Language": "zh-CN",
    Originator: "Codex Desktop",
    Accept: "application/json",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Dest": "empty",
    Priority: "u=4, i",
    "User-Agent": CODEX_USER_AGENT
  };
  if (account.accountId) headers["Chatgpt-Account-Id"] = account.accountId;
  return headers;
}


export function codexWindowLabel(prefix: string, windowSeconds?: number) {
  if (!windowSeconds || !Number.isFinite(windowSeconds)) return prefix;
  const hours = windowSeconds / 3600;
  if (hours >= 24 * 6) return `${prefix} 7天`;
  if (hours >= 4 && hours <= 6) return `${prefix} 5小时`;
  if (hours >= 24) return `${prefix} ${Math.round(hours / 24)}天`;
  if (hours >= 1) return `${prefix} ${Math.round(hours)}小时`;
  return `${prefix} ${Math.max(1, Math.round(windowSeconds / 60))}分钟`;
}

export function codexWindowResetAt(window: Record<string, unknown>) {
  const resetAtSeconds = numberField(window, "reset_at");
  if (resetAtSeconds && resetAtSeconds > 0) return new Date(resetAtSeconds * 1000).toISOString();
  const resetAfterSeconds = numberField(window, "reset_after_seconds");
  if (resetAfterSeconds && resetAfterSeconds > 0) return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  return undefined;
}

export function stageFromCodexWindow(prefix: string, rawWindow: unknown): TemporaryAccountQuotaStage | undefined {
  if (!isRecord(rawWindow)) return undefined;
  const used = numberField(rawWindow, "used_percent");
  const windowSeconds = numberField(rawWindow, "limit_window_seconds");
  if (used == null && !windowSeconds) return undefined;
  return {
    label: codexWindowLabel(prefix, windowSeconds),
    remaining: used == null ? undefined : Math.max(0, 100 - used),
    total: 100,
    used,
    unit: "%",
    resetAt: codexWindowResetAt(rawWindow)
  };
}

export function stagesFromCodexRateLimit(prefix: string, rawRateLimit: unknown) {
  if (!isRecord(rawRateLimit)) return [];
  return [
    stageFromCodexWindow(prefix, rawRateLimit.primary_window),
    stageFromCodexWindow(prefix, rawRateLimit.secondary_window)
  ].filter((stage): stage is TemporaryAccountQuotaStage => Boolean(stage));
}

export function codexRateLimitIsAvailable(rawRateLimit: unknown) {
  if (!isRecord(rawRateLimit)) return undefined;
  if (rawRateLimit.allowed === false || rawRateLimit.limit_reached === true) return false;
  const windows = [rawRateLimit.primary_window, rawRateLimit.secondary_window].filter(isRecord);
  if (windows.some((window) => (numberField(window, "used_percent") || 0) >= 100)) return false;
  return true;
}

export function codexUsageCheckResult(payload: unknown) {
  const stages: TemporaryAccountQuotaStage[] = [];
  if (!isRecord(payload)) return { availability: "available" as const, stages };

  stages.push(...stagesFromCodexRateLimit("总额度", payload.rate_limit));
  let selectedAvailability = codexRateLimitIsAvailable(payload.rate_limit);

  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const item of additional) {
    if (!isRecord(item)) continue;
    const feature = typeof item.metered_feature === "string" ? item.metered_feature : "";
    const limitName = typeof item.limit_name === "string" ? item.limit_name : "";
    const isCodex = `${feature} ${limitName}`.toLowerCase().includes("codex");
    const label = isCodex ? "Codex" : limitName || feature || "附加额度";
    stages.push(...stagesFromCodexRateLimit(label, item.rate_limit));
    if (isCodex) selectedAvailability = codexRateLimitIsAvailable(item.rate_limit);
  }

  const resetCredits = isRecord(payload.rate_limit_reset_credits) ? payload.rate_limit_reset_credits : undefined;
  const availableCount = typeof resetCredits?.available_count === "number" ? resetCredits.available_count : undefined;
  if (availableCount != null) {
    stages.push({
      label: "主动重置次数",
      remaining: availableCount,
      unit: "次"
    });
  }

  return {
    availability: selectedAvailability === false ? "unavailable" as const : "available" as const,
    stages
  };
}

export async function fetchCodexUsage(account: TemporaryAccount, accessToken = account.secret, proxyConfig?: RouteProxyConfig) {
  return fetchTemporaryAccountCheckText(CODEX_USAGE_URL, {
    headers: codexQuotaHeaders(account, accessToken)
  }, proxyConfig);
}


export function codexTemporaryHeaders(account: TemporaryAccount, templateHeaders: Record<string, string>, stream: boolean) {
  const headers: Record<string, string> = {
    ...templateHeaders,
    "Content-Type": "application/json",
    Authorization: `Bearer ${account.secret}`,
    Accept: stream ? "text/event-stream" : "application/json",
    Connection: "Keep-Alive"
  };
  if (!headerValue(headers, "User-Agent")) setHeader(headers, "User-Agent", CODEX_USER_AGENT);
  if (!headerValue(headers, "Originator")) setHeader(headers, "Originator", CODEX_ORIGINATOR);
  if (!headerValue(headers, "Session_id")) setHeader(headers, "Session_id", randomBytes(16).toString("hex"));
  if (account.accountId && !headerValue(headers, "Chatgpt-Account-Id")) setHeader(headers, "Chatgpt-Account-Id", account.accountId);
  return headers;
}

export function codexTemporaryRequestBody(body: unknown, model: string) {
  const source: Record<string, unknown> = isRecord(body) ? { ...body } : { input: body };
  source.model = model;
  source.store = false;
  source.stream = true;
  delete source.metadata;
  delete source.max_output_tokens;
  delete source.previous_response_id;
  delete source.prompt_cache_retention;
  delete source.safety_identifier;
  delete source.stream_options;
  return source;
}

export async function collectCodexResponsesBody(stream: ReadableStream<Uint8Array>) {
  let preview = "";
  let completedResponse: unknown;
  for await (const event of sseJsonObjectsFromReadable(stream)) {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    preview += chunk;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    if (isRecord(event) && event.type === "response.completed" && isRecord(event.response)) {
      completedResponse = event.response;
    } else if (isRecord(event) && isRecord(event.response)) {
      completedResponse = event.response;
    }
  }
  if (!completedResponse) throw new Error("Codex 上游未返回 response.completed");
  return {
    text: JSON.stringify(completedResponse),
    preview
  };
}


