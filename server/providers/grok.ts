import { randomBytes } from "node:crypto";
import {
  bodyRecord,
  emailFromIdToken,
  extractUpstreamError,
  isRecord,
  looksLikeHtml,
  looksLikeHtmlText,
  textFromContent
} from "../util/text.js";
import { openAiMessagesFromAnyBody } from "../convert/payload.js";
import { convertUpstreamResponseText } from "../convert/stream.js";
import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_TOKEN_URL,
  XAI_RESPONSES_URL,
  fetchTemporaryAccountCheckText
} from "./constants.js";
import type { ProxyKind, RosettaConverter } from "../proxy-path.js";
import type { RouteProxyConfig, TemporaryAccount, TemporaryAccountQuotaStage } from "../../shared/types.js";

export function grokMessageFromBody(body: unknown) {
  const source = bodyRecord(body);
  const messages = openAiMessagesFromAnyBody(body);
  const text = messages
    .map((message) => {
      if (!isRecord(message)) return "";
      const role = typeof message.role === "string" ? message.role : "user";
      const content = textFromContent(message.content);
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
  return text || textFromContent(source.prompt) || textFromContent(source.message) || textFromContent(source.input);
}

export function grokWebRequestBody(body: unknown, model: string) {
  const message = grokMessageFromBody(body);
  if (!message) throw new Error("Grok Web SSO 请求缺少可发送的文本内容");
  return {
    temporary: false,
    modelName: model,
    message,
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: true,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: true,
    imageGenerationCount: 2,
    forceConcise: false,
    toolOverrides: {},
    enableSideBySide: true,
    isPreset: false,
    sendFinalMetadata: true,
    customInstructions: "",
    deepsearchPreset: "",
    isReasoning: false,
    webpageUrls: [],
    disableTextFollowUps: false,
    responseMetadata: { requestModelDetails: { modelId: model } },
    disableMemory: false,
    forceSideBySide: false,
    modelMode: model,
    isAsyncChat: false
  };
}

export function grokWebTextFromEvent(event: unknown) {
  if (!isRecord(event)) return "";
  const result = isRecord(event.result) ? event.result : {};
  const response = isRecord(result.response) ? result.response : {};
  const token = typeof response.token === "string" ? response.token : "";
  const modelResponse = isRecord(response.modelResponse) ? response.modelResponse : {};
  const message = typeof modelResponse.message === "string" ? modelResponse.message : "";
  return token || message;
}

export function extractGrokWebResponseText(text: string) {
  const tokens: string[] = [];
  let finalMessage = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const eventText = grokWebTextFromEvent(parsed);
      if (eventText) tokens.push(eventText);
      const result = isRecord(parsed) && isRecord(parsed.result) ? parsed.result : {};
      const response = isRecord(result.response) ? result.response : {};
      const modelResponse = isRecord(response.modelResponse) ? response.modelResponse : {};
      if (typeof modelResponse.message === "string") finalMessage = modelResponse.message;
    } catch {
      // Grok Web returns NDJSON; ignore non-JSON keepalive lines.
    }
  }
  return finalMessage || tokens.join("");
}

export function grokWebToChatCompletionText(text: string, model: string) {
  const content = extractGrokWebResponseText(text);
  if (!content) return text;
  return JSON.stringify({
    id: `chatcmpl-grok-web-${randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ]
  });
}

export async function collectGrokWebStreamBody(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return text;
}

export function adaptGrokWebResponseText(text: string, proxyKind: ProxyKind, model: string, converter?: RosettaConverter, downstreamStream = false) {
  const chatText = grokWebToChatCompletionText(text, model);
  return convertUpstreamResponseText({
    text: chatText,
    contentType: "application/json; charset=utf-8",
    proxyKind,
    converter,
    downstreamStream
  });
}

export function isGrokWebTemporaryAccount(account: TemporaryAccount | undefined): account is TemporaryAccount {
  return account?.providerType === "grok" && !isGrokOAuthTemporaryAccount(account);
}

export function isGrokOAuthTemporaryAccount(account: TemporaryAccount | undefined) {
  if (account?.providerType !== "grok") return false;
  if (account.refreshToken?.trim() || account.idToken?.trim()) return true;
  return account.secret.split(".").length === 3;
}





export function grokCookiePairsFromText(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const normalized = trimmed.replace(/^(?:cookie|cookies)\s*[:：=]\s*/i, "");
  if (!normalized.includes("=") && /^[A-Za-z0-9._\-]{20,}$/.test(normalized)) return [`cf_clearance=${normalized}`];
  return normalized
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return [];
      const key = part.slice(0, separatorIndex).trim();
      const val = part.slice(separatorIndex + 1).trim();
      if (!key || !val) return [];
      const normalizedKey = key.toLowerCase();
      if (!["cf_clearance", "__cf_bm", "_cfuvid"].includes(normalizedKey)) return [];
      return [`${key}=${val}`];
    });
}

export function grokSsoCookie(secret: string, browserCookieState?: string) {
  const token = secret.trim().replace(/^sso=/i, "");
  return [`sso=${token}`, `sso-rw=${token}`, ...grokCookiePairsFromText(browserCookieState)].join("; ");
}

export function grokStatsigId() {
  const message = `x1:TypeError: Cannot read properties of undefined (reading '${randomBytes(5).toString("hex")}')`;
  return Buffer.from(message).toString("base64");
}

export function grokCookieDiagnostics(account: TemporaryAccount) {
  const cookie = grokSsoCookie(account.secret, account.sessionToken);
  return {
    hasSso: /(?:^|;\s*)sso=/.test(cookie),
    hasSsoRw: /(?:^|;\s*)sso-rw=/.test(cookie),
    hasCfClearance: /(?:^|;\s*)cf_clearance=/.test(cookie),
    hasCfBm: /(?:^|;\s*)__cf_bm=/.test(cookie),
    hasCfuvid: /(?:^|;\s*)_cfuvid=/.test(cookie)
  };
}

export function grokCookieDiagnosticText(account: TemporaryAccount) {
  const diagnostics = grokCookieDiagnostics(account);
  const present = [
    diagnostics.hasSso ? "sso" : "",
    diagnostics.hasSsoRw ? "sso-rw" : "",
    diagnostics.hasCfClearance ? "cf_clearance" : "",
    diagnostics.hasCfBm ? "__cf_bm" : "",
    diagnostics.hasCfuvid ? "_cfuvid" : ""
  ].filter(Boolean);
  return present.length > 0 ? `Cookie: ${present.join("+")}` : "Cookie: 未识别到 sso/cf_clearance";
}

export function grokFailureMessage(statusCode: number, text: string, contentType?: string, account?: TemporaryAccount) {
  const normalized = text.toLowerCase();
  const cookieHint = account ? `；${grokCookieDiagnosticText(account)}` : "";
  if (looksLikeHtml(contentType, text) || looksLikeHtmlText(text)) {
    const cloudflareHint = normalized.includes("cloudflare") || normalized.includes("cf-") ? "Cloudflare/浏览器校验页" : "HTML 页面";
    return `Grok 返回 ${cloudflareHint}（HTTP ${statusCode}），当前出口环境未通过浏览器校验或浏览器态已失效，需要使用健康的防封代理/Docker 环境并导入最新 cf_clearance${cookieHint}`;
  }
  if (grokInvalidCredentialsText(text)) {
    return `Grok SSO 会话无效或已过期（HTTP ${statusCode}），请重新导入 sso/sso-rw${cookieHint}`;
  }
  if (statusCode === 403) {
    return `Grok 返回 403，通常是出口 IP/浏览器指纹/Cloudflare Cookie 不健康，请切到防封 Docker 代理并确认 cf_clearance 与该出口匹配${cookieHint}${text.trim() ? `：${extractUpstreamError(text)}` : ""}`;
  }
  return extractUpstreamError(text) || `HTTP ${statusCode}`;
}

export function grokTemporaryHeaders(account: TemporaryAccount, templateHeaders: Record<string, string> = {}) {
  return {
    ...templateHeaders,
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
    Cookie: grokSsoCookie(account.secret, account.sessionToken),
    Origin: "https://grok.com",
    Priority: "u=1, i",
    Referer: "https://grok.com/",
    "Sec-Ch-Ua": '"Google Chrome";v="137", "Chromium";v="137", "Not(A:Brand";v="24"',
    "Sec-Ch-Ua-Arch": "arm",
    "Sec-Ch-Ua-Bitness": "64",
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Model": "",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "x-statsig-id": grokStatsigId(),
    "x-xai-request-id": randomBytes(16).toString("hex")
  };
}


export const GROK_RATE_LIMIT_MODES = [
  { label: "Fast", modelName: "fast" },
  { label: "Auto", modelName: "auto" },
  { label: "Expert", modelName: "expert" },
  { label: "Heavy", modelName: "heavy" },
  { label: "Grok 4.3", modelName: "grok-420-computer-use-sa" }
];

export function grokInvalidCredentialsText(text: string) {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("invalid-credentials") ||
    normalized.includes("bad-credentials") ||
    normalized.includes("failed to look up session id") ||
    normalized.includes("blocked-user") ||
    normalized.includes("email-domain-rejected") ||
    normalized.includes("session not found") ||
    normalized.includes("account suspended") ||
    normalized.includes("token revoked") ||
    normalized.includes("token expired")
  );
}

export function grokBrowserEnvironmentIssueText(text = "") {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("cloudflare") ||
    normalized.includes("cf_clearance") ||
    normalized.includes("__cf_bm") ||
    normalized.includes("_cfuvid") ||
    normalized.includes("浏览器") ||
    normalized.includes("防封") ||
    normalized.includes("出口") ||
    normalized.includes("环境") ||
    normalized.includes("html 页面") ||
    normalized.includes("html page") ||
    normalized.includes("just a moment")
  );
}

export function grokQuotaStage(label: string, payload: unknown): TemporaryAccountQuotaStage | undefined {
  if (!isRecord(payload)) return undefined;
  const remaining = typeof payload.remainingQueries === "number" ? payload.remainingQueries : undefined;
  if (remaining == null) return undefined;
  const total = typeof payload.totalQueries === "number" ? payload.totalQueries : remaining;
  const windowSeconds = typeof payload.windowSizeSeconds === "number" ? payload.windowSizeSeconds : undefined;
  return {
    label,
    remaining,
    total,
    unit: "次",
    resetAt: windowSeconds && windowSeconds > 0 ? new Date(Date.now() + windowSeconds * 1000).toISOString() : undefined
  };
}

export function numberHeader(headers: Headers, name: string) {
  const value = Number(headers.get(name));
  return Number.isFinite(value) ? value : undefined;
}

export function xaiQuotaStageFromHeaders(label: string, headers: Headers, dimension: "requests" | "tokens"): TemporaryAccountQuotaStage | undefined {
  const remaining = numberHeader(headers, `x-ratelimit-remaining-${dimension}`);
  const total = numberHeader(headers, `x-ratelimit-limit-${dimension}`);
  const reset = headers.get(`x-ratelimit-reset-${dimension}`);
  if (remaining == null && total == null && !reset) return undefined;
  const resetNumber = reset ? Number(reset) : undefined;
  const resetAt = reset && resetNumber != null && Number.isFinite(resetNumber)
    ? new Date((resetNumber > 1_000_000_000_000 ? resetNumber : resetNumber * 1000)).toISOString()
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

export function grokOAuthHeaders(account: TemporaryAccount, accessToken = account.secret) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "samapi-grok-oauth/1.0"
  };
}

export async function refreshGrokOAuthTemporaryAccountToken(account: TemporaryAccount, proxyConfig?: RouteProxyConfig) {
  if (!account.refreshToken?.trim()) return undefined;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: account.refreshToken.trim()
  });
  const { response, text } = await fetchTemporaryAccountCheckText(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "samapi-grok-oauth/1.0"
    },
    body
  }, proxyConfig);
  if (!response.ok) throw new Error(`刷新 Grok OAuth token 失败：${response.status} ${extractUpstreamError(text)}`);
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) throw new Error("刷新 Grok OAuth token 失败：响应缺少 access_token");
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim() ? payload.refresh_token.trim() : account.refreshToken;
  const idToken = typeof payload.id_token === "string" && payload.id_token.trim() ? payload.id_token.trim() : account.idToken;
  const email = emailFromIdToken(idToken) || account.email;
  return {
    secret: accessToken,
    refreshToken,
    idToken,
    email
  };
}

export async function fetchGrokOAuthResponses(account: TemporaryAccount, accessToken = account.secret, proxyConfig?: RouteProxyConfig) {
  const model = account.models.find((item) => item.toLowerCase().includes("grok")) || "grok-4.3";
  return fetchTemporaryAccountCheckText(XAI_RESPONSES_URL, {
    method: "POST",
    headers: grokOAuthHeaders(account, accessToken),
    body: JSON.stringify({
      model,
      input: "hi",
      stream: false
    })
  }, proxyConfig);
}

