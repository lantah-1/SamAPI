import { randomBytes, randomUUID } from "node:crypto";
import {
  codexAccountIdFromIdToken,
  emailFromIdToken,
  extractUpstreamError,
  headerValue,
  isRecord,
  numberField,
  setHeader
} from "../util/text.js";
import { sseJsonObjectsFromReadable, streamEventErrorMessage } from "../convert/stream.js";
import {
  CODEX_RESET_CREDITS_LIST_URL,
  CODEX_RESET_CREDITS_URL,
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

export interface CodexResetCredit {
  id: string;
  expiresAt: string;
}

export interface CodexResetCreditDetails {
  availableCount?: number;
  credits: CodexResetCredit[];
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
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0 && payload.expires_in < 365 * 86400 ? payload.expires_in : undefined;
  return {
    secret: accessToken,
    refreshToken,
    idToken,
    accountId: codexAccountIdFromIdToken(idToken) || account.accountId,
    email: emailFromIdToken(idToken) || account.email,
    tokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined
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
  if (account.chatgptAccountIsFedramp) headers["x-openai-fedramp"] = "true";
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

function stringField(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function resetCreditAvailableCount(value: unknown) {
  const count = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isInteger(count) && count >= 0 ? count : undefined;
}

export function codexResetCreditDetails(payload: unknown): CodexResetCreditDetails {
  let availableCount: number | undefined;
  let rawCredits: unknown[] = [];
  if (Array.isArray(payload)) {
    rawCredits = payload;
  } else if (isRecord(payload)) {
    availableCount = resetCreditAvailableCount(payload.available_count ?? payload.availableCount);
    for (const key of ["credits", "rate_limit_reset_credits", "items", "data"] as const) {
      if (Array.isArray(payload[key])) {
        rawCredits = payload[key];
        break;
      }
    }
  }
  let availableCreditCount = 0;
  const credits = rawCredits.flatMap((item): CodexResetCredit[] => {
    if (!isRecord(item)) return [];
    const resetType = stringField(item, "reset_type", "resetType");
    if (resetType && resetType.toLowerCase() !== "codex_rate_limits") return [];
    const status = stringField(item, "status");
    if (status && status.toLowerCase() !== "available") return [];
    availableCreditCount += 1;
    const id = stringField(item, "id", "credit_id", "creditId");
    const expiresAt = stringField(item, "expires_at", "expiresAt");
    return id && Number.isFinite(Date.parse(expiresAt)) ? [{ id, expiresAt }] : [];
  });
  return {
    availableCount: availableCount ?? (rawCredits.length > 0 ? availableCreditCount : undefined),
    credits: credits.sort((left, right) => {
      const leftTime = Date.parse(left.expiresAt);
      const rightTime = Date.parse(right.expiresAt);
      if (!Number.isFinite(leftTime)) return 1;
      if (!Number.isFinite(rightTime)) return -1;
      return leftTime - rightTime;
    })
  };
}

export function earliestCodexResetCredit(details: CodexResetCreditDetails | undefined, now = Date.now()) {
  return details ? [...details.credits]
    .filter((credit) => {
      const expiresAt = Date.parse(credit.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now;
    })
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))[0] : undefined;
}

export function codexUsageCheckResult(payload: unknown, resetCreditDetails?: CodexResetCreditDetails) {
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
  const availableCount = resetCreditDetails?.availableCount ?? resetCreditAvailableCount(resetCredits?.available_count);
  if (availableCount != null) {
    stages.push({
      label: "主动重置次数",
      remaining: availableCount,
      unit: "次",
      resetCreditExpiresAt: resetCreditDetails?.credits
        .filter((credit) => Date.parse(credit.expiresAt) > Date.now())
        .map((credit) => credit.expiresAt)
    });
  }

  return {
    availability: selectedAvailability === false ? "unavailable" as const : "available" as const,
    stages
  };
}

export async function fetchCodexUsage(account: TemporaryAccount, accessToken = account.secret, proxyConfig?: RouteProxyConfig, authorizationIsComplete = false) {
  const headers = codexQuotaHeaders(account, accessToken);
  if (authorizationIsComplete) headers.Authorization = accessToken;
  return fetchTemporaryAccountCheckText(CODEX_USAGE_URL, { headers }, proxyConfig);
}

export async function fetchCodexResetCredits(
  account: TemporaryAccount,
  accessToken = account.secret,
  proxyConfig?: RouteProxyConfig,
  authorizationIsComplete = false,
  strict = false
) {
  const headers = codexQuotaHeaders(account, accessToken);
  if (authorizationIsComplete) headers.Authorization = accessToken;
  const { response, text } = await fetchTemporaryAccountCheckText(CODEX_RESET_CREDITS_LIST_URL, { headers }, proxyConfig);
  if (!response.ok) {
    if (!strict) return undefined;
    const detail = extractUpstreamError(text) || `HTTP ${response.status}`;
    throw new Error(`获取 Codex 重置卡详情失败：HTTP ${response.status} ${detail}`);
  }
  try {
    return codexResetCreditDetails(text ? JSON.parse(text) : []);
  } catch {
    if (strict) throw new Error("获取 Codex 重置卡详情失败：上游返回内容不是合法 JSON");
    return undefined;
  }
}

export async function resetCodexTemporaryAccount(
  account: TemporaryAccount,
  accessToken = account.secret,
  proxyConfig?: RouteProxyConfig,
  authorizationIsComplete = false,
  creditId?: string
) {
  const headers = codexQuotaHeaders(account, accessToken);
  if (authorizationIsComplete) headers.Authorization = accessToken;
  headers["Content-Type"] = "application/json";
  const redeemRequestId = randomUUID();
  const { response, text } = await fetchTemporaryAccountCheckText(CODEX_RESET_CREDITS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      redeem_request_id: redeemRequestId,
      ...(creditId ? { credit_id: creditId } : {})
    })
  }, proxyConfig);
  if (!response.ok) {
    const detail = extractUpstreamError(text) || `HTTP ${response.status}`;
    throw new Error(`重置 Codex 额度失败：HTTP ${response.status} ${detail}`);
  }
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error("重置 Codex 额度失败：上游返回内容不是合法 JSON");
  }
}


export function codexTemporaryHeaders(account: TemporaryAccount, templateHeaders: Record<string, string>, stream: boolean) {
  const headers: Record<string, string> = { ...templateHeaders };
  // Header names are case-insensitive. Assigning canonical names directly can leave both
  // e.g. `content-type` and `Content-Type` in this object; fetch then combines them into
  // `application/json, application/json`, which the Codex backend rejects.
  setHeader(headers, "Content-Type", "application/json");
  setHeader(headers, "Authorization", `Bearer ${account.secret}`);
  setHeader(headers, "Accept", stream ? "text/event-stream" : "application/json");
  setHeader(headers, "Connection", "Keep-Alive");
  if (!headerValue(headers, "User-Agent")) setHeader(headers, "User-Agent", CODEX_USER_AGENT);
  if (!headerValue(headers, "Originator")) setHeader(headers, "Originator", CODEX_ORIGINATOR);
  if (!headerValue(headers, "Session_id")) setHeader(headers, "Session_id", randomBytes(16).toString("hex"));
  if (account.accountId && !headerValue(headers, "Chatgpt-Account-Id")) setHeader(headers, "Chatgpt-Account-Id", account.accountId);
  if (account.chatgptAccountIsFedramp && !headerValue(headers, "x-openai-fedramp")) setHeader(headers, "x-openai-fedramp", "true");
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
  try {
    for await (const event of sseJsonObjectsFromReadable(stream)) {
      const errorMessage = streamEventErrorMessage(event);
      if (errorMessage) throw new Error(errorMessage);
      const chunk = `data: ${JSON.stringify(event)}\n\n`;
      preview += chunk;
      if (preview.length > 1200) preview = preview.slice(0, 1200);
      if (isRecord(event) && ["response.completed", "response.incomplete"].includes(String(event.type)) && isRecord(event.response)) {
        completedResponse = event.response;
        break;
      }
    }
  } finally {
    // Release both completed and failed streams, even when the upstream leaves the socket open.
    await stream.cancel().catch(() => {});
  }
  if (!completedResponse) throw new Error("Codex 上游未返回 response.completed");
  return {
    text: JSON.stringify(completedResponse),
    preview
  };
}
