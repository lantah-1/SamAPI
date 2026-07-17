import { createHash, randomBytes, randomUUID } from "node:crypto";
import { emailFromIdToken, extractUpstreamError } from "../util/text.js";
import {
  XAI_CLI_CHAT_PROXY_BASE_URL,
  XAI_DEFAULT_API_BASE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_TOKEN_URL,
  fetchTemporaryAccountCheckText
} from "./constants.js";
import type { RouteProxyConfig, TemporaryAccount, TemporaryAccountQuotaStage } from "../../shared/types.js";

const CPA_CLIENT_VERSION = "0.2.93";
const GROK2API_CLIENT_VERSION = "0.2.99";

function trimmedBaseUrl(value?: string) {
  return value?.trim().replace(/\/+$/, "");
}

function isDefaultXaiApiBaseUrl(value?: string) {
  return trimmedBaseUrl(value) === XAI_DEFAULT_API_BASE_URL;
}

export function isGrokOAuthTemporaryAccount(account: TemporaryAccount | undefined): account is TemporaryAccount {
  return account?.providerType === "grok" && Boolean(account.grokOAuthFormat || account.refreshToken?.trim() || account.idToken?.trim());
}

export function grokOAuthBaseUrl(account: TemporaryAccount) {
  const importedBaseUrl = trimmedBaseUrl(account.upstreamBaseUrl);
  if (account.grokOAuthFormat === "grok2api-oauth") return importedBaseUrl || XAI_CLI_CHAT_PROXY_BASE_URL;
  if (account.grokUsingApi) return importedBaseUrl || XAI_DEFAULT_API_BASE_URL;
  if (importedBaseUrl && !isDefaultXaiApiBaseUrl(importedBaseUrl)) return importedBaseUrl;
  return XAI_CLI_CHAT_PROXY_BASE_URL;
}

export function grokOAuthResponsesUrl(account: TemporaryAccount) {
  return `${grokOAuthBaseUrl(account)}/responses`;
}

export function grokOAuthAccessTokenNeedsRefresh(account: TemporaryAccount) {
  if (!account.secret.trim()) return true;
  if (!account.tokenExpiresAt) return false;
  const expiresAt = Date.parse(account.tokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 5 * 60 * 1000;
}

function stableHexId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function grokOAuthHeaders(
  account: TemporaryAccount,
  accessToken = account.secret,
  stream = false,
  conversationId = randomBytes(16).toString("hex"),
  model = ""
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Connection: "Keep-Alive",
    "x-grok-conv-id": conversationId
  };
  const baseUrl = grokOAuthBaseUrl(account);
  if (account.grokOAuthFormat === "grok2api-oauth") {
    const sessionId = randomUUID();
    const requestId = randomBytes(16).toString("hex");
    headers["X-XAI-Token-Auth"] = "xai-grok-cli";
    headers["x-grok-client-version"] = GROK2API_CLIENT_VERSION;
    headers["x-grok-client-identifier"] = "grok-shell";
    headers["x-grok-client-surface"] = "tui";
    headers["x-grok-client-name"] = "grok-shell";
    headers["x-grok-agent-id"] = stableHexId(account.id);
    headers["x-grok-session-id"] = sessionId;
    headers["x-grok-session-id-legacy"] = sessionId;
    headers["x-grok-req-id"] = requestId;
    headers["x-grok-request-id"] = requestId;
    headers["x-grok-conversation-id"] = conversationId;
    headers["Accept-Encoding"] = stream ? "identity" : "gzip";
    headers["User-Agent"] = `grok-shell/${GROK2API_CLIENT_VERSION} (linux; x86_64)`;
    headers.traceparent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
    headers.tracestate = "";
    if (account.accountId) headers["x-userid"] = account.accountId;
    if (model) headers["x-grok-model-override"] = model;
  } else if (baseUrl === XAI_CLI_CHAT_PROXY_BASE_URL) {
    headers["X-XAI-Token-Auth"] = "xai-grok-cli";
    headers["x-grok-client-version"] = CPA_CLIENT_VERSION;
    headers["User-Agent"] = `xai-grok-workspace/${CPA_CLIENT_VERSION}`;
  } else {
    headers["User-Agent"] = "samapi-grok-oauth/1.0";
  }
  return headers;
}

export async function refreshGrokOAuthTemporaryAccountToken(account: TemporaryAccount, proxyConfig?: RouteProxyConfig) {
  if (!account.refreshToken?.trim()) return undefined;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: account.oauthClientId?.trim() || XAI_OAUTH_CLIENT_ID,
    refresh_token: account.refreshToken.trim()
  });
  const { response, text } = await fetchTemporaryAccountCheckText(account.oauthTokenEndpoint?.trim() || XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "samapi-grok-oauth/1.0"
    },
    body
  }, proxyConfig);
  if (!response.ok) {
    const detail = extractUpstreamError(text) || text.trim() || "unknown_error";
    if (response.status === 400 && /invalid_grant/i.test(detail)) {
      throw new Error("刷新 Grok OAuth token 失败：refresh_token 已失效（invalid_grant），请重新导入该账号");
    }
    if ([401, 403].includes(response.status)) {
      throw new Error(`刷新 Grok OAuth token 失败：授权已失效（HTTP ${response.status} ${detail}），请重新导入该账号`);
    }
    throw new Error(`刷新 Grok OAuth token 失败：HTTP ${response.status} ${detail}`);
  }
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) throw new Error("刷新 Grok OAuth token 失败：响应缺少 access_token");
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim() ? payload.refresh_token.trim() : account.refreshToken;
  const idToken = typeof payload.id_token === "string" && payload.id_token.trim() ? payload.id_token.trim() : account.idToken;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  return {
    secret: accessToken,
    refreshToken,
    idToken,
    email: emailFromIdToken(idToken) || account.email,
    tokenExpiresAt: Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : account.tokenExpiresAt
  };
}

export async function fetchGrokOAuthResponses(account: TemporaryAccount, model: string, accessToken = account.secret, proxyConfig?: RouteProxyConfig) {
  const resolvedModel = model.trim();
  if (!resolvedModel) throw new Error("请先在上游密钥中为 Grok 配置模型");
  return fetchTemporaryAccountCheckText(grokOAuthResponsesUrl(account), {
    method: "POST",
    headers: grokOAuthHeaders(account, accessToken, false, randomBytes(16).toString("hex"), resolvedModel),
    body: JSON.stringify({
      model: resolvedModel,
      input: "hi",
      stream: false
    })
  }, proxyConfig);
}

function numberHeader(headers: Headers, name: string) {
  const value = Number(headers.get(name));
  return Number.isFinite(value) ? value : undefined;
}

function xaiQuotaStageFromHeaders(label: string, headers: Headers, dimension: "requests" | "tokens"): TemporaryAccountQuotaStage | undefined {
  const remaining = numberHeader(headers, `x-ratelimit-remaining-${dimension}`);
  const total = numberHeader(headers, `x-ratelimit-limit-${dimension}`);
  const reset = headers.get(`x-ratelimit-reset-${dimension}`);
  if (remaining == null && total == null && !reset) return undefined;
  const resetNumber = reset ? Number(reset) : undefined;
  const resetAt = reset && resetNumber != null && Number.isFinite(resetNumber)
    ? new Date(resetNumber > 1_000_000_000_000 ? resetNumber : resetNumber * 1000).toISOString()
    : reset || undefined;
  return {
    label,
    remaining,
    total,
    unit: dimension === "requests" ? "次" : "tokens",
    resetAt
  };
}

export function xaiQuotaStagesFromHeaders(headers: Headers) {
  return [
    xaiQuotaStageFromHeaders("xAI 请求额度", headers, "requests"),
    xaiQuotaStageFromHeaders("xAI Token 额度", headers, "tokens")
  ].filter((stage): stage is TemporaryAccountQuotaStage => Boolean(stage));
}
