import http from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { ProxyAgent } from "undici";
import {
  ChatCompletionToMessagesConverter,
  ChatCompletionToResponsesConverter,
  GeminiToChatCompletionConverter,
  GeminiToMessagesConverter,
  GeminiToResponsesConverter,
  MessagesToChatCompletionConverter,
  MessagesToResponsesConverter,
  ResponsesToChatCompletionConverter,
  ResponsesToMessagesConverter
} from "@zenmux/rosetta-ai";
import { JsonStore, parseHeaderTemplate } from "./store.js";
import type {
  GroupRoute,
  HeaderTemplate,
  ProviderApiKeyEntry,
  ProviderModelSyncResult,
  RequestLog,
  RequestLogProxy,
  RequestLogStatus,
  RouteProxyConfig,
  RouteRecord,
  Site,
  SiteAddress,
  SwitchRoute,
  TemporaryAccount,
  TemporaryAccountCheckItemResult,
  TemporaryAccountCheckResult,
  TemporaryAccountProviderType,
  TemporaryAccountQuotaStage
} from "../shared/types.js";

const PORT = Number(process.env.SAMAPI_PORT || process.env.PORT || 8787);
const HOST = process.env.SAMAPI_HOST || "0.0.0.0";
const WEB_DIR = path.resolve(process.env.SAMAPI_WEB_DIR || path.join(process.cwd(), "dist"));
const store = new JsonStore();
const ADMIN_PASSWORD = process.env.SAMAPI_ADMIN_PASSWORD || "samapi-admin";
const ADMIN_PASSWORD_IS_DEFAULT = !process.env.SAMAPI_ADMIN_PASSWORD;
const ADMIN_SESSION_COOKIE = "samapi_admin";
const ADMIN_COOKIE_SECURE = process.env.SAMAPI_ADMIN_COOKIE_SECURE === "true";
const routeRuntimeState = new Map<string, { stableCandidateKey?: string }>();
const DEFAULT_CORS_HEADERS = [
  "Accept",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Content-Type",
  "Priority",
  "X-API-Key",
  "X-App",
  "X-Stainless-Arch",
  "X-Stainless-Lang",
  "X-Stainless-OS",
  "X-Stainless-Package-Version",
  "X-Stainless-Retry-Count",
  "X-Stainless-Runtime",
  "X-Stainless-Runtime-Version",
  "X-Stainless-Timeout",
  "Anthropic-Beta",
  "Anthropic-Dangerous-Direct-Browser-Access",
  "Anthropic-Version"
].join(",");

function normalizedProxyUrl(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed || ["0", "false", "off", "none", "direct"].includes(trimmed.toLowerCase())) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function proxyFromAppEnvironment() {
  return normalizedProxyUrl(process.env.SAMAPI_PROXY_URL);
}

function proxyFromGenericEnvironment() {
  return normalizedProxyUrl(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
  );
}

function parseKeyValueProxyValue(output: string, key: string) {
  const match = output.match(new RegExp(`${key}\\s*:\\s*([^\\n]+)`));
  return match?.[1]?.trim();
}

function proxyUrlFromHostPort(host?: string, port?: string | number, protocol = "http") {
  const normalizedHost = host?.trim();
  const normalizedPort = String(port || "").trim();
  if (!normalizedHost || !normalizedPort || normalizedHost === "0.0.0.0") return undefined;
  return `${protocol}://${normalizedHost}:${normalizedPort}`;
}

function proxyFromMacOsScutil() {
  if (process.platform !== "darwin") return undefined;
  try {
    const output = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 1200 });
    const httpsEnabled = parseKeyValueProxyValue(output, "HTTPSEnable") === "1";
    const httpEnabled = parseKeyValueProxyValue(output, "HTTPEnable") === "1";
    if (httpsEnabled) {
      return proxyUrlFromHostPort(parseKeyValueProxyValue(output, "HTTPSProxy"), parseKeyValueProxyValue(output, "HTTPSPort"));
    }
    if (httpEnabled) {
      return proxyUrlFromHostPort(parseKeyValueProxyValue(output, "HTTPProxy"), parseKeyValueProxyValue(output, "HTTPPort"));
    }
    const socksEnabled = parseKeyValueProxyValue(output, "SOCKSEnable") === "1";
    if (socksEnabled) {
      return proxyUrlFromHostPort(parseKeyValueProxyValue(output, "SOCKSProxy"), parseKeyValueProxyValue(output, "SOCKSPort"), "socks5");
    }
  } catch {
    // Fall through to networksetup.
  }
  return undefined;
}

function parseNetworkSetupProxy(output: string) {
  const enabled = parseKeyValueProxyValue(output, "Enabled")?.toLowerCase() === "yes";
  if (!enabled) return undefined;
  return proxyUrlFromHostPort(parseKeyValueProxyValue(output, "Server"), parseKeyValueProxyValue(output, "Port"));
}

function macOsNetworkServices() {
  try {
    const output = execFileSync("networksetup", ["-listallnetworkservices"], { encoding: "utf8", timeout: 1500 });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("An asterisk") && !line.startsWith("*"));
  } catch {
    return [];
  }
}

function proxyFromMacOsNetworkSetup() {
  if (process.platform !== "darwin") return undefined;
  for (const service of macOsNetworkServices()) {
    for (const [command, protocol] of [
      ["-getsecurewebproxy", "http"],
      ["-getwebproxy", "http"],
      ["-getsocksfirewallproxy", "socks5"]
    ] as const) {
      try {
        const output = execFileSync("networksetup", [command, service], { encoding: "utf8", timeout: 1500 });
        const proxyUrl = parseNetworkSetupProxy(output)?.replace(/^http:\/\//, `${protocol}://`);
        if (proxyUrl) return proxyUrl;
      } catch {
        // Try the next service or proxy kind.
      }
    }
  }
  return undefined;
}

function proxyFromSystemSettings() {
  if (process.platform === "darwin") return proxyFromMacOsScutil() || proxyFromMacOsNetworkSetup();
  return undefined;
}

interface ResolvedProxy {
  mode: RequestLogProxy["mode"];
  url?: string;
  source?: RequestLogProxy["source"];
}

const proxyAgents = new Map<string, ProxyAgent>();
let systemProxyCache: { checkedAt: number; proxy?: ResolvedProxy } = { checkedAt: 0 };
const SYSTEM_PROXY_CACHE_TTL_MS = 10_000;

function resolveSystemProxy(force = false): ResolvedProxy {
  const nowMs = Date.now();
  if (!force && nowMs - systemProxyCache.checkedAt < SYSTEM_PROXY_CACHE_TTL_MS) return systemProxyCache.proxy || { mode: "system" };
  const envProxy = proxyFromAppEnvironment() || proxyFromGenericEnvironment();
  const systemProxy = envProxy ? undefined : proxyFromSystemSettings();
  const proxy = envProxy
    ? { mode: "system" as const, url: envProxy, source: "env" as const }
    : systemProxy
      ? { mode: "system" as const, url: systemProxy, source: "system" as const }
      : { mode: "system" as const };
  systemProxyCache = { checkedAt: nowMs, proxy };
  return proxy;
}

function routeProxy(routeProxy?: RouteProxyConfig, forceSystemRefresh = false): ResolvedProxy {
  if (!routeProxy || routeProxy.mode === "direct") return { mode: "direct" };
  if (routeProxy.mode === "custom") return { mode: "custom", url: routeProxy.url, source: "route" };
  return resolveSystemProxy(forceSystemRefresh);
}

function maskedProxyUrlValue(proxyUrl?: string) {
  return proxyUrl ? maskedProxyUrl(proxyUrl) : undefined;
}

function requestLogProxyForRoute(routeProxyConfig?: RouteProxyConfig, forceSystemRefresh = false): RequestLogProxy {
  const resolvedProxy = routeProxy(routeProxyConfig, forceSystemRefresh);
  return { ...resolvedProxy, url: maskedProxyUrlValue(resolvedProxy.url) };
}

function proxyAgentFor(proxyUrl: string) {
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const agent = new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

function clearProxyAgent(proxyUrl?: string) {
  if (!proxyUrl) return;
  proxyAgents.delete(proxyUrl);
}

function isNetworkError(error: unknown) {
  const message = errorText(error).toLowerCase();
  const cause = nestedErrorCause(error);
  const causeCause = nestedErrorCause(cause);
  const code = errorCode(error) || errorCode(cause) || errorCode(causeCause);
  return Boolean(
    code ||
      message.includes("fetch failed") ||
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("socket")
  );
}

async function fetchWithRouteProxy(target: Parameters<typeof fetch>[0], init: RequestInit, routeProxyConfig?: RouteProxyConfig) {
  let resolvedProxy = routeProxy(routeProxyConfig);
  const proxyInit = resolvedProxy.url ? { ...init, dispatcher: proxyAgentFor(resolvedProxy.url) } as RequestInit & { dispatcher: ProxyAgent } : init;
  try {
    const response = await fetch(target, proxyInit);
    return { response, proxy: { ...resolvedProxy, url: maskedProxyUrlValue(resolvedProxy.url) } satisfies RequestLogProxy };
  } catch (error) {
    if (!routeProxyConfig || routeProxyConfig.mode === "direct" || !isNetworkError(error)) throw error;
    clearProxyAgent(resolvedProxy.url);
    resolvedProxy = routeProxy(routeProxyConfig, true);
    const retryInit = resolvedProxy.url ? { ...init, dispatcher: proxyAgentFor(resolvedProxy.url) } as RequestInit & { dispatcher: ProxyAgent } : init;
    const response = await fetch(target, retryInit);
    return { response, proxy: { ...resolvedProxy, url: maskedProxyUrlValue(resolvedProxy.url), retried: true } satisfies RequestLogProxy };
  }
}

interface ProxyExecutionCandidate {
  site: Site;
  addresses: SiteAddress[];
  model: string;
  providerApiKey?: ProviderApiKeyEntry;
  temporaryAccount?: TemporaryAccount;
  temporaryApiKeyAccount?: TemporaryAccount;
  headerTemplate?: HeaderTemplate;
  index: number;
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown, headers: http.OutgoingHttpHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": DEFAULT_CORS_HEADERS,
    "Access-Control-Expose-Headers": "*",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendCorsPreflight(request: http.IncomingMessage, response: http.ServerResponse) {
  const requestedHeaders = valueToHeaderText(request.headers["access-control-request-headers"]);
  response.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": requestedHeaders || DEFAULT_CORS_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Access-Control-Request-Headers"
  });
  response.end();
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest();
}

function safeEqualText(left: string, right: string) {
  return timingSafeEqual(hashText(left), hashText(right));
}

function safeEqualPasswordHash(password: string, expectedHash?: string) {
  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  return timingSafeEqual(hashText(password), Buffer.from(expectedHash, "hex"));
}

function verifyAdminPassword(password: string) {
  const savedHash = store.getAdminPasswordHash();
  return savedHash ? safeEqualPasswordHash(password, savedHash) : safeEqualText(password, ADMIN_PASSWORD);
}

function parseCookies(request: http.IncomingMessage) {
  const cookieHeader = request.headers.cookie || "";
  const cookies = new Map<string, string>();
  for (const segment of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = segment.split("=");
    const name = rawName?.trim();
    if (!name) continue;
    cookies.set(name, decodeURIComponent(rawValue.join("=").trim()));
  }
  return cookies;
}

function adminSessionSecret() {
  return process.env.SAMAPI_ADMIN_SESSION_SECRET || store.getAdminPasswordHash() || hashText(ADMIN_PASSWORD).toString("hex");
}

function signAdminSession(payload: string) {
  return createHmac("sha256", adminSessionSecret()).update(payload).digest("base64url");
}

function adminSessionTtlMs() {
  return store.getDb().settings.adminSessionTtlMinutes * 60 * 1000;
}

function createAdminSession() {
  const nowMs = Date.now();
  const expiresAtMs = nowMs + adminSessionTtlMs();
  const payload = Buffer.from(
    JSON.stringify({
      iat: nowMs,
      exp: expiresAtMs,
      nonce: randomBytes(16).toString("base64url")
    })
  ).toString("base64url");
  return {
    token: `${payload}.${signAdminSession(payload)}`,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

function verifyAdminSessionToken(token?: string) {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqualText(signature, signAdminSession(payload))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown; iat?: unknown };
    const nowMs = Date.now();
    if (typeof parsed.exp !== "number" || parsed.exp <= nowMs) return false;
    if (typeof parsed.iat === "number" && nowMs - parsed.iat > adminSessionTtlMs()) return false;
    return true;
  } catch {
    return false;
  }
}

function hasAdminSession(request: http.IncomingMessage) {
  return verifyAdminSessionToken(parseCookies(request).get(ADMIN_SESSION_COOKIE));
}

function renewAdminSession(response: http.ServerResponse) {
  const session = createAdminSession();
  response.setHeader("Set-Cookie", adminSessionCookie(session.token));
  return session;
}

function adminSessionCookie(token: string) {
  const maxAge = Math.max(0, Math.floor(adminSessionTtlMs() / 1000));
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${ADMIN_COOKIE_SECURE ? "; Secure" : ""}`;
}

function clearAdminSessionCookie() {
  return `${ADMIN_SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${ADMIN_COOKIE_SECURE ? "; Secure" : ""}`;
}

function isPublicApiPath(method: string, pathname: string) {
  return (
    (method === "GET" && pathname === "/api/health") ||
    (method === "GET" && pathname === "/api/auth/session") ||
    (method === "POST" && pathname === "/api/auth/login") ||
    (method === "POST" && pathname === "/api/auth/logout")
  );
}

function requireAdminSession(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const method = request.method || "GET";
  if (isPublicApiPath(method, url.pathname)) return true;
  if (hasAdminSession(request)) {
    renewAdminSession(response);
    return true;
  }
  sendJson(response, 401, { error: "请先输入管理密码" });
  return false;
}

function routeParam(parts: string[], index: number) {
  return decodeURIComponent(parts[index] || "");
}

function notFound(response: http.ServerResponse) {
  sendJson(response, 404, { error: "Not found" });
}

function staticContentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function safeStaticPath(pathname: string) {
  let decoded = "/";
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(WEB_DIR, relativePath);
  const root = WEB_DIR.endsWith(path.sep) ? WEB_DIR : `${WEB_DIR}${path.sep}`;
  if (resolved !== WEB_DIR && !resolved.startsWith(root)) return undefined;
  return resolved;
}

function sendStaticFile(request: http.IncomingMessage, response: http.ServerResponse, filePath: string) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  response.writeHead(200, {
    "Content-Type": staticContentType(filePath),
    "Content-Length": stats.size,
    "Cache-Control": path.basename(filePath) === "index.html" ? "no-store" : "public, max-age=31536000, immutable"
  });
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  createReadStream(filePath).pipe(response);
  return true;
}

function handleStatic(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  if (!["GET", "HEAD"].includes(request.method || "")) return false;
  if (!existsSync(WEB_DIR)) return false;
  const filePath = safeStaticPath(url.pathname);
  if (filePath && sendStaticFile(request, response, filePath)) return true;
  const indexPath = path.join(WEB_DIR, "index.html");
  return sendStaticFile(request, response, indexPath);
}

function valueToHeaderText(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(", ");
  return value || "";
}

function maskRequestHeaders(headers: http.IncomingHttpHeaders) {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (["authorization", "x-api-key", "cookie"].includes(key.toLowerCase())) {
      masked[key] = value ? "***" : "";
      continue;
    }
    masked[key] = valueToHeaderText(value);
  }
  return masked;
}

function responsePreview(text: string) {
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

function compactPreview(text: string) {
  return responsePreview(text.replace(/\s+/g, " ").trim());
}

function requestApiKey(request: http.IncomingMessage, url: URL) {
  const apiKey = request.headers.authorization || request.headers["x-api-key"] || url.searchParams.get("key") || undefined;
  return Array.isArray(apiKey) ? apiKey[0] : apiKey;
}

function maskSecret(secret: string) {
  const trimmed = secret.trim();
  return trimmed ? `${trimmed.slice(0, 10)}...` : "";
}

function extractUpstreamError(text: string) {
  try {
    const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof payload.error === "string") return payload.error;
    if (payload.error && typeof payload.error === "object" && "message" in payload.error) {
      const message = (payload.error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
  } catch {
    // Fall back to a compact text preview for non-JSON upstream errors.
  }
  return compactPreview(text);
}

function looksLikeHtmlText(text: string) {
  const compact = text.trim().slice(0, 120).toLowerCase();
  return compact.startsWith("<!doctype") || compact.startsWith("<html") || compact.includes("<head") || compact.includes("<body");
}

function maskedProxyUrl(proxyUrl: string) {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return proxyUrl.replace(/\/\/[^/@]+@/, "//***@");
  }
}

function errorText(value: unknown) {
  return value instanceof Error && value.message.trim() ? value.message.trim() : "";
}

function errorCode(value: unknown) {
  if (!isRecord(value)) return "";
  const code = value.code;
  return typeof code === "string" && code.trim() ? code.trim() : "";
}

function errorDetailValue(value: unknown, key: string) {
  if (!isRecord(value)) return "";
  const detail = value[key];
  return typeof detail === "string" || typeof detail === "number" ? String(detail) : "";
}

function nestedErrorCause(error: unknown) {
  if (!isRecord(error)) return undefined;
  if (error.cause) return error.cause;
  const errors = error.errors;
  return Array.isArray(errors) ? errors.find(Boolean) : undefined;
}

function networkErrorReason(code: string) {
  const normalized = code.toUpperCase();
  if (normalized === "ENOTFOUND" || normalized === "EAI_AGAIN") return "DNS 解析失败";
  if (normalized === "ECONNREFUSED") return "连接被拒绝";
  if (normalized === "ECONNRESET" || normalized === "UND_ERR_SOCKET") return "连接被重置";
  if (normalized === "ETIMEDOUT" || normalized === "UND_ERR_CONNECT_TIMEOUT" || normalized === "UND_ERR_HEADERS_TIMEOUT") return "连接超时";
  if (normalized.includes("CERT") || normalized.includes("TLS") || normalized.includes("SSL")) return "TLS 证书校验失败";
  return "";
}

function upstreamNetworkErrorMessage(error: unknown, fallback: string) {
  const cause = nestedErrorCause(error);
  const causeCause = nestedErrorCause(cause);
  const detailSource = causeCause || cause || error;
  const code = errorCode(detailSource) || errorCode(cause) || errorCode(error);
  const reason = networkErrorReason(code);
  const host = errorDetailValue(detailSource, "hostname") || errorDetailValue(detailSource, "host");
  const port = errorDetailValue(detailSource, "port");
  const address = errorDetailValue(detailSource, "address");
  const message = errorText(error);
  const causeMessage = errorText(detailSource);
  const parts = [
    reason,
    code,
    host ? `host ${host}` : "",
    port ? `port ${port}` : "",
    address ? `address ${address}` : "",
    causeMessage && causeMessage !== message ? causeMessage : ""
  ].filter(Boolean);

  if (message && message !== "fetch failed" && parts.length === 0) return message;

  const currentProxy = resolveSystemProxy();
  const proxyHint = currentProxy.url
    ? `当前系统代理 ${maskedProxyUrl(currentProxy.url)}，请确认代理可访问 OpenAI/Codex`
    : "当前未配置系统代理，请确认服务器可直连 OpenAI/Codex，或为对应路由设置代理";
  const detailText = parts.length > 0 ? `${parts.join("；")}；${proxyHint}` : proxyHint;
  return `${fallback}：${detailText}`;
}

function joinUrl(baseUrl: string, suffix: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function v1BaseUrl(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = /\/v\d+$/i.test(pathname) ? pathname.replace(/\/v\d+$/i, "/v1") : `${pathname}/v1`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return joinUrl(baseUrl, "v1");
  }
}

function requestModelName(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const model = (body as { model?: unknown }).model;
  return typeof model === "string" ? model.trim() : "";
}

type ProxyKind = "generic" | "models" | "messages" | "chat-completions" | "responses" | "gemini-generate" | "gemini-stream";
type RouteEndpointKind = "messages" | "chat/completions" | "responses";
type RosettaConverter = {
  convertRequest: (payload: unknown) => unknown;
  convertResponse: (payload: unknown) => unknown;
  convertStream?: (stream: AsyncIterable<unknown>) => AsyncIterable<unknown>;
};

function normalizedProxyPath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

function proxyPathInfo(pathname: string): { supported: boolean; kind: ProxyKind; routeNameFromPath?: string } {
  const normalized = normalizedProxyPath(pathname);
  if (normalized === "/proxy") return { supported: true, kind: "generic" };
  if (["/proxy/models", "/proxy/v1/models", "/proxy/v1beta/models"].includes(normalized)) return { supported: true, kind: "models" };
  if (["/proxy/messages", "/proxy/v1/messages"].includes(normalized)) return { supported: true, kind: "messages" };
  if (
    [
      "/proxy/chat/complete",
      "/proxy/v1/chat/complete",
      "/proxy/chat/completion",
      "/proxy/v1/chat/completion",
      "/proxy/chat/completions",
      "/proxy/v1/chat/completions"
    ].includes(normalized)
  ) {
    return { supported: true, kind: "chat-completions" };
  }
  if (["/proxy/response", "/proxy/v1/response", "/proxy/responses", "/proxy/v1/responses"].includes(normalized)) {
    return { supported: true, kind: "responses" };
  }

  const geminiMatch = normalized.match(/^\/proxy\/(?:v1|v1beta)\/models\/([^/]+):(generateContent|streamGenerateContent)$/);
  if (geminiMatch) {
    return {
      supported: true,
      kind: geminiMatch[2] === "streamGenerateContent" ? "gemini-stream" : "gemini-generate",
      routeNameFromPath: decodeURIComponent(geminiMatch[1])
    };
  }
  return { supported: false, kind: "generic" };
}

function proxyRouteName(pathname: string, body: unknown) {
  return proxyPathInfo(pathname).routeNameFromPath || requestModelName(body);
}

function isSupportedProxyPath(pathname: string) {
  return proxyPathInfo(pathname).supported;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const text = "text" in item ? (item as { text?: unknown }).text : undefined;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function bodyRecord(body: unknown) {
  return isRecord(body) ? body : {};
}

function systemText(value: unknown) {
  return textFromContent(value);
}

function anthropicContentToText(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return "";
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "tool_result") {
        return typeof item.content === "string" ? item.content : textFromContent(item.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicMessagesToOpenAiMessages(body: unknown) {
  const source = bodyRecord(body);
  const messages: Array<Record<string, unknown>> = [];
  const system = systemText(source.system);
  if (system) messages.push({ role: "system", content: system });

  const sourceMessages = Array.isArray(source.messages) ? source.messages : [];
  for (const message of sourceMessages) {
    if (!isRecord(message)) continue;
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
    const content = message.content;

    if (role === "assistant" && Array.isArray(content)) {
      const toolCalls = content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "tool_use")
        .map((part, index) => ({
          id: typeof part.id === "string" ? part.id : `tool-${index + 1}`,
          type: "function",
          function: {
            name: typeof part.name === "string" ? part.name : "tool",
            arguments: JSON.stringify(isRecord(part.input) ? part.input : {})
          }
        }));
      messages.push({
        role,
        content: anthropicContentToText(content) || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    if (role === "user" && Array.isArray(content)) {
      const toolResults = content.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "tool_result");
      if (toolResults.length > 0) {
        for (const part of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: typeof part.tool_use_id === "string" ? part.tool_use_id : "tool",
            content: typeof part.content === "string" ? part.content : textFromContent(part.content)
          });
        }
        const plainText = anthropicContentToText(content.filter((part) => !isRecord(part) || part.type !== "tool_result"));
        if (plainText) messages.push({ role: "user", content: plainText });
        continue;
      }
    }

    messages.push({ role, content: anthropicContentToText(content) || "" });
  }
  return messages;
}

function anthropicToolsToOpenAiChatTools(body: unknown) {
  const tools = bodyRecord(body).tools;
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter((tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} }
      }
    }));
  return converted.length > 0 ? converted : undefined;
}

function anthropicToolsToOpenAiResponseTools(body: unknown) {
  const tools = bodyRecord(body).tools;
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter((tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} }
    }));
  return converted.length > 0 ? converted : undefined;
}

function anthropicToolChoiceToOpenAiChat(body: unknown) {
  const toolChoice = bodyRecord(body).tool_choice;
  if (!isRecord(toolChoice)) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

function commonGenerationOptions(body: unknown) {
  const source = bodyRecord(body);
  return {
    ...(typeof source.temperature === "number" ? { temperature: source.temperature } : {}),
    ...(typeof source.top_p === "number" ? { top_p: source.top_p } : {}),
    ...(typeof source.max_tokens === "number" ? { max_tokens: source.max_tokens } : {}),
    ...(Array.isArray(source.stop_sequences) ? { stop: source.stop_sequences } : {})
  };
}

function anthropicMessagesToOpenAiChatBody(body: unknown, routeModel: string) {
  const source = bodyRecord(body);
  const tools = anthropicToolsToOpenAiChatTools(body);
  const toolChoice = anthropicToolChoiceToOpenAiChat(body);
  return {
    model: routeModel,
    messages: anthropicMessagesToOpenAiMessages(body),
    ...commonGenerationOptions(body),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(typeof source.stream === "boolean" ? { stream: false } : {})
  };
}

function anthropicMessagesToOpenAiResponsesBody(body: unknown, routeModel: string) {
  const source = bodyRecord(body);
  const tools = anthropicToolsToOpenAiResponseTools(body);
  const options = commonGenerationOptions(body);
  const { max_tokens, ...restOptions } = options;
  return {
    model: routeModel,
    input: anthropicMessagesToOpenAiMessages(body),
    ...(max_tokens ? { max_output_tokens: max_tokens } : {}),
    ...restOptions,
    ...(tools ? { tools } : {}),
    ...(typeof source.stream === "boolean" ? { stream: false } : {})
  };
}

function isStreamingRequest(body: unknown) {
  return bodyRecord(body).stream === true;
}

function rosettaConverter(proxyKind: ProxyKind, routeEndpoint: RouteEndpointKind): RosettaConverter | undefined {
  if (proxyKind === "messages") {
    if (routeEndpoint === "chat/completions") return new MessagesToChatCompletionConverter() as RosettaConverter;
    if (routeEndpoint === "responses") return new MessagesToResponsesConverter() as RosettaConverter;
  }
  if (proxyKind === "chat-completions" || proxyKind === "generic") {
    if (routeEndpoint === "messages") return new ChatCompletionToMessagesConverter() as RosettaConverter;
    if (routeEndpoint === "responses") return new ChatCompletionToResponsesConverter() as RosettaConverter;
  }
  if (proxyKind === "responses") {
    if (routeEndpoint === "messages") return new ResponsesToMessagesConverter() as RosettaConverter;
    if (routeEndpoint === "chat/completions") return new ResponsesToChatCompletionConverter() as RosettaConverter;
  }
  if (proxyKind === "gemini-generate" || proxyKind === "gemini-stream") {
    if (routeEndpoint === "messages") return new GeminiToMessagesConverter() as RosettaConverter;
    if (routeEndpoint === "chat/completions") return new GeminiToChatCompletionConverter() as RosettaConverter;
    if (routeEndpoint === "responses") return new GeminiToResponsesConverter() as RosettaConverter;
  }
  return undefined;
}

function applyRouteModel(payload: unknown, routeModel: string) {
  if (isRecord(payload)) return { ...payload, model: routeModel };
  return payload;
}

function normalizeGeminiConverterInput(body: unknown, routeModel: string) {
  const source = bodyRecord(body);
  const generationConfig = isRecord(source.generationConfig) ? source.generationConfig : {};
  return {
    ...source,
    model: routeModel,
    config: {
      ...generationConfig,
      ...(source.systemInstruction ? { systemInstruction: source.systemInstruction } : {}),
      ...(source.tools ? { tools: source.tools } : {}),
      ...(source.toolConfig ? { toolConfig: source.toolConfig } : {})
    }
  };
}

function convertedRouteRequestBody(body: unknown, routeModel: string, routeEndpoint: RouteEndpointKind, proxyKind: ProxyKind) {
  const converter = rosettaConverter(proxyKind, routeEndpoint);
  if (converter) {
    const source =
      proxyKind === "gemini-generate" || proxyKind === "gemini-stream"
        ? normalizeGeminiConverterInput(body, routeModel)
        : applyRouteModel(body, routeModel);
    const converted = converter.convertRequest(source);
    return {
      body: applyRouteModel(converted, routeModel),
      converter
    };
  }
  return {
    body: routeRequestBody(body, routeModel, routeEndpoint, proxyKind),
    converter: undefined
  };
}

function geminiContentsToMessages(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const contents = (body as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return [];
  return contents.map((content) => {
    if (!content || typeof content !== "object") return { role: "user", content: "" };
    const role = (content as { role?: unknown }).role === "model" ? "assistant" : "user";
    const parts = (content as { parts?: unknown }).parts;
    const text = Array.isArray(parts)
      ? parts
          .map((part) => {
            if (!part || typeof part !== "object") return "";
            const value = (part as { text?: unknown }).text;
            return typeof value === "string" ? value : "";
          })
          .filter(Boolean)
          .join("\n")
      : "";
    return { role, content: text };
  });
}

function geminiSystemText(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const instruction = (body as { systemInstruction?: unknown }).systemInstruction;
  if (!instruction || typeof instruction !== "object") return "";
  const parts = (instruction as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function geminiGenerationConfig(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const config = (body as { generationConfig?: unknown }).generationConfig;
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const source = config as Record<string, unknown>;
  return {
    ...(typeof source.temperature === "number" ? { temperature: source.temperature } : {}),
    ...(typeof source.topP === "number" ? { top_p: source.topP } : {}),
    ...(typeof source.maxOutputTokens === "number" ? { max_tokens: source.maxOutputTokens } : {})
  };
}

function routeRequestBody(body: unknown, routeModel: string, routeEndpoint: string, proxyKind: ProxyKind) {
  if (proxyKind === "gemini-generate" || proxyKind === "gemini-stream") {
    const messages = geminiContentsToMessages(body);
    const system = geminiSystemText(body);
    const config = geminiGenerationConfig(body);
    if (routeEndpoint === "messages") {
      return {
        model: routeModel,
        ...(system ? { system } : {}),
        messages: messages.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content
        })),
        ...config
      };
    }
    if (routeEndpoint === "chat/completions") {
      return {
        model: routeModel,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          ...messages
        ],
        ...config
      };
    }
    return {
      model: routeModel,
      input: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages
      ],
      ...config
    };
  }

  return body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), model: routeModel }
    : { input: body, model: routeModel };
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  if ("output_text" in payload && typeof (payload as { output_text?: unknown }).output_text === "string") {
    return (payload as { output_text: string }).output_text;
  }
  if ("content" in payload && Array.isArray((payload as { content?: unknown }).content)) {
    return textFromContent((payload as { content?: unknown }).content);
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    return choices
      .map((choice) => {
        if (!choice || typeof choice !== "object") return "";
        const message = (choice as { message?: unknown }).message;
        if (message && typeof message === "object") return textFromContent((message as { content?: unknown }).content);
        return textFromContent((choice as { text?: unknown }).text);
      })
      .filter(Boolean)
      .join("\n");
  }
  const output = (payload as { output?: unknown }).output;
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        return textFromContent((item as { content?: unknown }).content);
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function openAiMessagesFromAnyBody(body: unknown) {
  const source = bodyRecord(body);
  if (Array.isArray(source.messages)) return source.messages;
  if (Array.isArray(source.input)) return source.input;
  if (typeof source.input === "string") return [{ role: "user", content: source.input }];
  if (Array.isArray(source.contents)) return geminiContentsToMessages(body);
  return [];
}

function grokMessageFromBody(body: unknown) {
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

function grokWebRequestBody(body: unknown, model: string) {
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

function grokWebTextFromEvent(event: unknown) {
  if (!isRecord(event)) return "";
  const result = isRecord(event.result) ? event.result : {};
  const response = isRecord(result.response) ? result.response : {};
  const token = typeof response.token === "string" ? response.token : "";
  const modelResponse = isRecord(response.modelResponse) ? response.modelResponse : {};
  const message = typeof modelResponse.message === "string" ? modelResponse.message : "";
  return token || message;
}

function extractGrokWebResponseText(text: string) {
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

function grokWebToChatCompletionText(text: string, model: string) {
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

async function collectGrokWebStreamBody(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return text;
}

function adaptGrokWebResponseText(text: string, proxyKind: ProxyKind, model: string, converter?: RosettaConverter, downstreamStream = false) {
  const chatText = grokWebToChatCompletionText(text, model);
  return convertUpstreamResponseText({
    text: chatText,
    contentType: "application/json; charset=utf-8",
    proxyKind,
    converter,
    downstreamStream
  });
}

function isGrokWebTemporaryAccount(account: TemporaryAccount | undefined): account is TemporaryAccount {
  return account?.providerType === "grok" && !isGrokOAuthTemporaryAccount(account);
}

function isGrokOAuthTemporaryAccount(account: TemporaryAccount | undefined) {
  if (account?.providerType !== "grok") return false;
  if (account.refreshToken?.trim() || account.idToken?.trim()) return true;
  return account.secret.split(".").length === 3;
}

function adaptResponseText(text: string, contentType: string | undefined, proxyKind: ProxyKind) {
  if (proxyKind !== "gemini-generate" && proxyKind !== "gemini-stream") return { text, contentType };
  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === "object" && "candidates" in payload) return { text, contentType };
    const extracted = extractResponseText(payload);
    if (!extracted) return { text, contentType };
    return {
      text: JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: extracted }]
            },
            finishReason: "STOP",
            index: 0
          }
        ]
      }),
      contentType: "application/json; charset=utf-8"
    };
  } catch {
    return { text, contentType };
  }
}

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicMessageToSse(message: unknown) {
  const record = bodyRecord(message);
  const content = Array.isArray(record.content) ? record.content : [];
  const startMessage = {
    ...record,
    content: [],
    stop_reason: null,
    stop_sequence: null
  };
  let output = sseEvent("message_start", { type: "message_start", message: startMessage });
  content.forEach((block, index) => {
    const contentBlock = isRecord(block) ? block : { type: "text", text: String(block || "") };
    output += sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: contentBlock.type === "text" ? { type: "text", text: "" } : contentBlock
    });
    if (contentBlock.type === "text" && typeof contentBlock.text === "string" && contentBlock.text) {
      output += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: contentBlock.text }
      });
    }
    output += sseEvent("content_block_stop", { type: "content_block_stop", index });
  });
  output += sseEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: typeof record.stop_reason === "string" ? record.stop_reason : "end_turn",
      stop_sequence: record.stop_sequence ?? null
    },
    usage: isRecord(record.usage) ? record.usage : { output_tokens: 0 }
  });
  output += sseEvent("message_stop", { type: "message_stop" });
  return output;
}

function convertUpstreamResponseText(input: {
  text: string;
  contentType?: string;
  proxyKind: ProxyKind;
  converter?: RosettaConverter;
  downstreamStream: boolean;
}) {
  if (input.converter) {
    try {
      const converted = input.converter.convertResponse(JSON.parse(input.text));
      if (input.proxyKind === "messages" && input.downstreamStream) {
        return {
          text: anthropicMessageToSse(converted),
          contentType: "text/event-stream; charset=utf-8"
        };
      }
      return {
        text: JSON.stringify(converted),
        contentType: "application/json; charset=utf-8"
      };
    } catch {
      // Fall through to compatibility conversion.
    }
  }
  const adapted = adaptResponseText(input.text, input.contentType, input.proxyKind);
  return {
    ...adapted,
    contentType: adapted.contentType || input.contentType
  };
}

function applyStreamingFlag(body: unknown, stream: boolean) {
  return isRecord(body) ? { ...body, stream } : body;
}

function sanitizeOpenAiCompatibleResponsesBody(body: unknown, routeEndpoint: RouteEndpointKind) {
  if (routeEndpoint !== "responses" || !isRecord(body)) return body;
  const sanitized = { ...body };
  delete sanitized.metadata;
  return sanitized;
}

function maskedStringHeaders(headers: Record<string, string>) {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = ["authorization", "x-api-key", "cookie"].includes(key.toLowerCase()) ? "***" : value;
  }
  return masked;
}

function streamResponseContentType(proxyKind: ProxyKind, contentType?: string) {
  if (proxyKind === "messages" || proxyKind === "chat-completions" || proxyKind === "responses" || proxyKind === "generic") {
    return "text/event-stream; charset=utf-8";
  }
  return contentType || "text/event-stream; charset=utf-8";
}

async function writeResponseChunk(response: http.ServerResponse, chunk: string | Uint8Array) {
  if (response.destroyed || response.writableEnded) throw new Error("客户端已断开连接");
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("客户端已断开连接"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function* textChunksFromReadable(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string) {
  let event = "";
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return { event, data: data.join("\n") };
}

async function* sseJsonObjectsFromReadable(stream: ReadableStream<Uint8Array>) {
  let buffer = "";
  for await (const chunk of textChunksFromReadable(stream)) {
    buffer += chunk;
    let separatorIndex = buffer.search(/\r?\n\r?\n/);
    while (separatorIndex >= 0) {
      const frame = buffer.slice(0, separatorIndex);
      const separator = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
      buffer = buffer.slice(separatorIndex + separator.length);
      const parsed = parseSseFrame(frame);
      if (parsed.data && parsed.data !== "[DONE]") {
        yield JSON.parse(parsed.data);
      }
      separatorIndex = buffer.search(/\r?\n\r?\n/);
    }
  }
  const parsed = parseSseFrame(buffer);
  if (parsed.data && parsed.data !== "[DONE]") yield JSON.parse(parsed.data);
  if (!parsed.data && buffer.trim().startsWith("{")) yield JSON.parse(buffer);
}

function hasReasoningRequest(body: unknown) {
  const source = bodyRecord(body);
  return Boolean(source.reasoning_effort || source.reasoning || source.thinking);
}

function shouldNormalizeReasoningContent(routeModel: string, requestBody: unknown) {
  const model = routeModel.toLowerCase();
  return hasReasoningRequest(requestBody) && (model.includes("kimi") || model.includes("moonshot"));
}

function cloneOpenAiStreamChunkWithDelta(chunk: Record<string, unknown>, delta: Record<string, unknown>, finishReason?: unknown) {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  return {
    ...chunk,
    choices: [
      {
        ...firstChoice,
        delta,
        finish_reason: finishReason ?? null
      },
      ...choices.slice(1)
    ]
  };
}

function openAiReasoningSegments(text: string, state: { inReasoning: boolean }) {
  const segments: Array<{ kind: "reasoning" | "content"; text: string }> = [];
  let rest = text;
  while (rest) {
    if (state.inReasoning) {
      const closeIndex = rest.indexOf("</think>");
      const rawReasoning = closeIndex >= 0 ? rest.slice(0, closeIndex) : rest;
      const reasoning = rawReasoning.replace(/<think>/g, "");
      if (reasoning) segments.push({ kind: "reasoning", text: reasoning });
      if (closeIndex < 0) break;
      state.inReasoning = false;
      rest = rest.slice(closeIndex + "</think>".length).replace(/^\s+/, "");
      continue;
    }

    const openIndex = rest.indexOf("<think>");
    if (openIndex < 0) {
      segments.push({ kind: "content", text: rest });
      break;
    }
    const content = rest.slice(0, openIndex);
    if (content) segments.push({ kind: "content", text: content });
    state.inReasoning = true;
    rest = rest.slice(openIndex + "<think>".length);
  }
  return segments;
}

async function* normalizeOpenAiChatReasoningStream(input: {
  stream: AsyncIterable<unknown>;
  routeModel: string;
  requestBody: unknown;
}) {
  const state = { inReasoning: shouldNormalizeReasoningContent(input.routeModel, input.requestBody) };
  for await (const chunk of input.stream) {
    if (!isRecord(chunk)) {
      yield chunk;
      continue;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    const delta = isRecord(choice?.delta) ? choice.delta : undefined;
    const content = typeof delta?.content === "string" ? delta.content : "";
    const hasNativeReasoning = Boolean(delta && (delta.reasoning || delta.reasoning_content));
    if (!choice || !delta || !content || hasNativeReasoning) {
      yield chunk;
      continue;
    }

    const shouldInspectTags = state.inReasoning || content.includes("<think>") || content.includes("</think>");
    if (!shouldInspectTags) {
      yield chunk;
      continue;
    }

    const { content: _content, ...restDelta } = delta;
    const segments = openAiReasoningSegments(content, state);
    if (segments.length === 0) continue;
    for (const [index, segment] of segments.entries()) {
      const segmentDelta =
        segment.kind === "reasoning"
          ? { ...restDelta, reasoning_content: segment.text }
          : { ...restDelta, content: segment.text };
      const finishReason = index === segments.length - 1 ? choice.finish_reason : null;
      yield cloneOpenAiStreamChunkWithDelta(chunk, segmentDelta, finishReason);
    }
  }
}

function serializeStreamEvent(proxyKind: ProxyKind, event: unknown) {
  if (proxyKind === "messages") {
    const eventName = isRecord(event) && typeof event.type === "string" ? event.type : "message_delta";
    return `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
  }
  if (proxyKind === "responses") {
    const eventName = isRecord(event) && typeof event.type === "string" ? event.type : "response.output_text.delta";
    return `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
  }
  return `data: ${JSON.stringify(event)}\n\n`;
}

function streamEventErrorMessage(event: unknown) {
  if (!isRecord(event)) return "";
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const error = event.error;
  const errorRecord = isRecord(error) ? error : undefined;
  const message =
    (typeof errorRecord?.message === "string" && errorRecord.message) ||
    (typeof error === "string" && error) ||
    (typeof event.message === "string" && event.message) ||
    "";
  if (type === "error" || type.includes(".error") || type.endsWith(".failed") || errorRecord) {
    return message || JSON.stringify(event);
  }
  return "";
}

function streamPreviewErrorMessage(preview: string) {
  if (!/(^|\n)event:\s*error\b|"type"\s*:\s*"(?:error|response\.failed)"/i.test(preview)) return "";
  return extractUpstreamError(preview) || "上游流返回错误事件";
}

async function streamConvertedResponse(input: {
  upstreamBody: ReadableStream<Uint8Array>;
  response: http.ServerResponse;
  proxyKind: ProxyKind;
  routeEndpoint: RouteEndpointKind;
  routeModel: string;
  requestBody: unknown;
  converter: RosettaConverter;
}) {
  let preview = "";
  const upstreamStream =
    input.routeEndpoint === "chat/completions"
      ? normalizeOpenAiChatReasoningStream({
          stream: sseJsonObjectsFromReadable(input.upstreamBody),
          routeModel: input.routeModel,
          requestBody: input.requestBody
        })
      : sseJsonObjectsFromReadable(input.upstreamBody);
  for await (const event of input.converter.convertStream?.(upstreamStream) || []) {
    const chunk = serializeStreamEvent(input.proxyKind, event);
    preview += chunk;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    await writeResponseChunk(input.response, chunk);
    const errorMessage = streamEventErrorMessage(event);
    if (errorMessage) throw new Error(errorMessage);
  }
  if (input.proxyKind === "chat-completions" || input.proxyKind === "generic") {
    const done = "data: [DONE]\n\n";
    preview += done;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    await writeResponseChunk(input.response, done);
  }
  return preview;
}

async function streamRawResponse(input: {
  upstreamBody: ReadableStream<Uint8Array>;
  response: http.ServerResponse;
}) {
  let preview = "";
  for await (const chunk of textChunksFromReadable(input.upstreamBody)) {
    preview += chunk;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    await writeResponseChunk(input.response, chunk);
  }
  const errorMessage = streamPreviewErrorMessage(preview);
  if (errorMessage) throw new Error(errorMessage);
  return preview;
}

const CODEX_BACKEND_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USER_AGENT = "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)";
const CODEX_ORIGINATOR = "codex-tui";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const GROK_RATE_LIMITS_URL = "https://grok.com/rest/rate-limits";
const GROK_CONVERSATIONS_NEW_URL = "https://grok.com/rest/app-chat/conversations/new";
const CHATGPT_MODELS_URL = "https://chatgpt.com/backend-api/models";
const CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL = "ChatGPT 官方";
const TEMPORARY_ACCOUNT_CHECK_TIMEOUT_MS = positiveIntegerEnv("SAMAPI_TEMPORARY_ACCOUNT_CHECK_TIMEOUT_MS", 15_000);
const TEMPORARY_ACCOUNT_CHECK_CONCURRENCY = positiveIntegerEnv("SAMAPI_TEMPORARY_ACCOUNT_CHECK_CONCURRENCY", 6);

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function temporaryAccountCheckProxyFromBody(body: unknown): RouteProxyConfig {
  if (!isRecord(body)) return { mode: "system" };
  const proxy = isRecord(body.proxy) ? body.proxy : isRecord(body.checkProxy) ? body.checkProxy : undefined;
  if (!proxy) return { mode: "system" };
  const mode = proxy.mode;
  if (mode === "direct" || mode === "system") return { mode };
  if (mode === "custom") {
    const url = typeof proxy.url === "string" ? proxy.url.trim() : "";
    if (!url) throw new Error("自定义代理地址不能为空");
    return { mode, url };
  }
  return { mode: "system" };
}

function temporaryAccountProviderTypeFromBody(body: unknown): TemporaryAccountProviderType {
  if (!isRecord(body)) return "gpt";
  return body.providerType === "grok" ? "grok" : "gpt";
}

function grokCookiePairsFromText(value?: string) {
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

function grokSsoCookie(secret: string, browserCookieState?: string) {
  const token = secret.trim().replace(/^sso=/i, "");
  return [`sso=${token}`, `sso-rw=${token}`, ...grokCookiePairsFromText(browserCookieState)].join("; ");
}

function grokStatsigId() {
  const message = `x1:TypeError: Cannot read properties of undefined (reading '${randomBytes(5).toString("hex")}')`;
  return Buffer.from(message).toString("base64");
}

function grokCookieDiagnostics(account: TemporaryAccount) {
  const cookie = grokSsoCookie(account.secret, account.sessionToken);
  return {
    hasSso: /(?:^|;\s*)sso=/.test(cookie),
    hasSsoRw: /(?:^|;\s*)sso-rw=/.test(cookie),
    hasCfClearance: /(?:^|;\s*)cf_clearance=/.test(cookie),
    hasCfBm: /(?:^|;\s*)__cf_bm=/.test(cookie),
    hasCfuvid: /(?:^|;\s*)_cfuvid=/.test(cookie)
  };
}

function grokCookieDiagnosticText(account: TemporaryAccount) {
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

function grokFailureMessage(statusCode: number, text: string, contentType?: string, account?: TemporaryAccount) {
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

function grokTemporaryHeaders(account: TemporaryAccount, templateHeaders: Record<string, string> = {}) {
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

async function fetchTemporaryAccountCheckText(input: Parameters<typeof fetch>[0], init: RequestInit = {}, proxyConfig: RouteProxyConfig = { mode: "system" }) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TEMPORARY_ACCOUNT_CHECK_TIMEOUT_MS);

  try {
    const resolvedProxy = routeProxy(proxyConfig);
    const proxyInit = resolvedProxy.url
      ? { ...init, dispatcher: proxyAgentFor(resolvedProxy.url) } as RequestInit & { dispatcher: ProxyAgent }
      : init;
    const response = await fetch(input, {
      ...proxyInit,
      signal: controller.signal
    });
    return {
      response,
      text: await response.text()
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(`账号检查请求超时（${Math.round(TEMPORARY_ACCOUNT_CHECK_TIMEOUT_MS / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    })
  );
  return results;
}

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

function jwtPayload(token?: string) {
  const parts = token?.split(".") || [];
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function codexAccountIdFromIdToken(idToken?: string) {
  const payload = jwtPayload(idToken);
  const auth = isRecord(payload?.["https://api.openai.com/auth"]) ? payload?.["https://api.openai.com/auth"] : undefined;
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function emailFromIdToken(idToken?: string) {
  const email = jwtPayload(idToken)?.email;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

async function refreshCodexTemporaryAccountToken(account: TemporaryAccount, proxyConfig?: RouteProxyConfig) {
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
  if (!response.ok) throw new Error(`刷新 Codex token 失败：${response.status} ${extractUpstreamError(text)}`);
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

function codexQuotaHeaders(account: TemporaryAccount, accessToken = account.secret) {
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

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function codexWindowLabel(prefix: string, windowSeconds?: number) {
  if (!windowSeconds || !Number.isFinite(windowSeconds)) return prefix;
  const hours = windowSeconds / 3600;
  if (hours >= 24 * 6) return `${prefix} 7天`;
  if (hours >= 4 && hours <= 6) return `${prefix} 5小时`;
  if (hours >= 24) return `${prefix} ${Math.round(hours / 24)}天`;
  if (hours >= 1) return `${prefix} ${Math.round(hours)}小时`;
  return `${prefix} ${Math.max(1, Math.round(windowSeconds / 60))}分钟`;
}

function codexWindowResetAt(window: Record<string, unknown>) {
  const resetAtSeconds = numberField(window, "reset_at");
  if (resetAtSeconds && resetAtSeconds > 0) return new Date(resetAtSeconds * 1000).toISOString();
  const resetAfterSeconds = numberField(window, "reset_after_seconds");
  if (resetAfterSeconds && resetAfterSeconds > 0) return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  return undefined;
}

function stageFromCodexWindow(prefix: string, rawWindow: unknown): TemporaryAccountQuotaStage | undefined {
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

function stagesFromCodexRateLimit(prefix: string, rawRateLimit: unknown) {
  if (!isRecord(rawRateLimit)) return [];
  return [
    stageFromCodexWindow(prefix, rawRateLimit.primary_window),
    stageFromCodexWindow(prefix, rawRateLimit.secondary_window)
  ].filter((stage): stage is TemporaryAccountQuotaStage => Boolean(stage));
}

function codexRateLimitIsAvailable(rawRateLimit: unknown) {
  if (!isRecord(rawRateLimit)) return undefined;
  if (rawRateLimit.allowed === false || rawRateLimit.limit_reached === true) return false;
  const windows = [rawRateLimit.primary_window, rawRateLimit.secondary_window].filter(isRecord);
  if (windows.some((window) => (numberField(window, "used_percent") || 0) >= 100)) return false;
  return true;
}

function codexUsageCheckResult(payload: unknown) {
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

async function fetchCodexUsage(account: TemporaryAccount, accessToken = account.secret, proxyConfig?: RouteProxyConfig) {
  return fetchTemporaryAccountCheckText(CODEX_USAGE_URL, {
    headers: codexQuotaHeaders(account, accessToken)
  }, proxyConfig);
}

async function checkCodexTemporaryAccount(account: TemporaryAccount, checkedAt: string, proxyConfig?: RouteProxyConfig) {
  let tokenPatch:
    | {
        secret: string;
        refreshToken?: string;
        idToken?: string;
        accountId?: string;
        email?: string;
      }
    | undefined;
  let attempt = await fetchCodexUsage(account, account.secret, proxyConfig);
  if ([401, 403].includes(attempt.response.status) && account.refreshToken) {
    const refreshedTokenPatch = await refreshCodexTemporaryAccountToken(account, proxyConfig);
    if (refreshedTokenPatch) {
      tokenPatch = refreshedTokenPatch;
      const refreshedAccount = { ...account, ...tokenPatch };
      attempt = await fetchCodexUsage(refreshedAccount, tokenPatch.secret, proxyConfig);
    }
  }

  if (!attempt.response.ok) {
    const errorMessage = extractUpstreamError(attempt.text) || `HTTP ${attempt.response.status}`;
    return {
      patch: {
        ...tokenPatch,
        availability: "unavailable" as const,
        quotaStages: account.quotaStages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: attempt.response.status,
        lastCheckError: errorMessage
      },
      result: {
        availability: "unavailable" as const,
        status: "failed" as const,
        statusCode: attempt.response.status,
        quotaStages: account.quotaStages,
        errorMessage,
        checkedAt
      }
    };
  }

  let payload: unknown = {};
  try {
    payload = attempt.text ? JSON.parse(attempt.text) : {};
  } catch {
    const errorMessage = "Codex usage 返回内容不是合法 JSON";
    return {
      patch: {
        ...tokenPatch,
        availability: "unavailable" as const,
        quotaStages: account.quotaStages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: attempt.response.status,
        lastCheckError: errorMessage
      },
      result: {
        availability: "unavailable" as const,
        status: "failed" as const,
        statusCode: attempt.response.status,
        quotaStages: account.quotaStages,
        errorMessage,
        checkedAt
      }
    };
  }

  const parsed = codexUsageCheckResult(payload);
  const errorMessage = parsed.availability === "available" ? undefined : "Codex 额度已耗尽或当前不允许请求";
  return {
    patch: {
      ...tokenPatch,
      availability: parsed.availability,
      quotaStages: parsed.stages,
      lastQuotaCheckedAt: checkedAt,
      lastCheckStatusCode: attempt.response.status,
      lastCheckError: errorMessage
    },
    result: {
      availability: parsed.availability,
      status: parsed.availability === "available" ? "success" as const : "failed" as const,
      statusCode: attempt.response.status,
      quotaStages: parsed.stages,
      errorMessage,
      checkedAt
    }
  };
}

async function checkOpenAiApiKeyTemporaryAccount(account: TemporaryAccount, checkedAt: string, proxyConfig?: RouteProxyConfig) {
  const { response, text } = await fetchTemporaryAccountCheckText(OPENAI_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${account.secret}`,
      Accept: "application/json"
    }
  }, proxyConfig);
  if (!response.ok) {
    const errorMessage = extractUpstreamError(text) || `HTTP ${response.status}`;
    return {
      patch: {
        availability: "unavailable" as const,
        quotaStages: account.quotaStages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: response.status,
        lastCheckError: errorMessage
      },
      result: {
        availability: "unavailable" as const,
        status: "failed" as const,
        statusCode: response.status,
        quotaStages: account.quotaStages,
        errorMessage,
        checkedAt
      }
    };
  }
  return {
    patch: {
      availability: "available" as const,
      quotaStages: account.quotaStages,
      lastQuotaCheckedAt: checkedAt,
      lastCheckStatusCode: response.status,
      lastCheckError: undefined
    },
    result: {
      availability: "available" as const,
      status: "success" as const,
      statusCode: response.status,
      quotaStages: account.quotaStages,
      checkedAt
    }
  };
}

const GROK_RATE_LIMIT_MODES = [
  { label: "Fast", modelName: "fast" },
  { label: "Auto", modelName: "auto" },
  { label: "Expert", modelName: "expert" },
  { label: "Heavy", modelName: "heavy" },
  { label: "Grok 4.3", modelName: "grok-420-computer-use-sa" }
];

function grokInvalidCredentialsText(text: string) {
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

function grokBrowserEnvironmentIssueText(text = "") {
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

function grokQuotaStage(label: string, payload: unknown): TemporaryAccountQuotaStage | undefined {
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

function xaiQuotaStagesFromHeaders(headers: Headers) {
  return [
    xaiQuotaStageFromHeaders("xAI 请求额度", headers, "requests"),
    xaiQuotaStageFromHeaders("xAI Token 额度", headers, "tokens")
  ].filter((stage): stage is TemporaryAccountQuotaStage => Boolean(stage));
}

function grokOAuthHeaders(account: TemporaryAccount, accessToken = account.secret) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "samapi-grok-oauth/1.0"
  };
}

async function refreshGrokOAuthTemporaryAccountToken(account: TemporaryAccount, proxyConfig?: RouteProxyConfig) {
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

async function fetchGrokOAuthResponses(account: TemporaryAccount, accessToken = account.secret, proxyConfig?: RouteProxyConfig) {
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

async function checkGrokOAuthTemporaryAccount(account: TemporaryAccount, checkedAt: string, proxyConfig?: RouteProxyConfig) {
  let tokenPatch:
    | {
        secret: string;
        refreshToken?: string;
        idToken?: string;
        email?: string;
      }
    | undefined;
  let attempt = await fetchGrokOAuthResponses(account, account.secret, proxyConfig);
  if (attempt.response.status === 401 && account.refreshToken) {
    const refreshedTokenPatch = await refreshGrokOAuthTemporaryAccountToken(account, proxyConfig);
    if (refreshedTokenPatch) {
      tokenPatch = refreshedTokenPatch;
      const refreshedAccount = { ...account, ...tokenPatch };
      attempt = await fetchGrokOAuthResponses(refreshedAccount, tokenPatch.secret, proxyConfig);
    }
  }

  const quotaStages = xaiQuotaStagesFromHeaders(attempt.response.headers);
  if (!attempt.response.ok) {
    const errorMessage = extractUpstreamError(attempt.text) || `HTTP ${attempt.response.status}`;
    const availability = attempt.response.status === 429 ? "unavailable" as const : "unavailable" as const;
    return {
      patch: {
        ...tokenPatch,
        availability,
        quotaStages: quotaStages.length > 0 ? quotaStages : account.quotaStages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: attempt.response.status,
        lastCheckError: errorMessage
      },
      result: {
        availability,
        status: "failed" as const,
        statusCode: attempt.response.status,
        quotaStages: quotaStages.length > 0 ? quotaStages : account.quotaStages,
        errorMessage,
        checkedAt
      }
    };
  }

  return {
    patch: {
      ...tokenPatch,
      availability: "available" as const,
      quotaStages,
      lastQuotaCheckedAt: checkedAt,
      lastCheckStatusCode: attempt.response.status,
      lastCheckError: undefined
    },
    result: {
      availability: "available" as const,
      status: "success" as const,
      statusCode: attempt.response.status,
      quotaStages,
      checkedAt
    }
  };
}

async function checkGrokTemporaryAccount(account: TemporaryAccount, checkedAt: string, proxyConfig?: RouteProxyConfig) {
  if (isGrokOAuthTemporaryAccount(account)) return checkGrokOAuthTemporaryAccount(account, checkedAt, proxyConfig);
  const existingQuotaStages = account.quotaStages;

  const checks = await Promise.all(
    GROK_RATE_LIMIT_MODES.map(async (mode) => {
      try {
        const { response, text } = await fetchTemporaryAccountCheckText(GROK_RATE_LIMITS_URL, {
          method: "POST",
          headers: grokTemporaryHeaders(account),
          body: JSON.stringify({ modelName: mode.modelName })
        }, proxyConfig);
        if (looksLikeHtmlText(text)) {
          return { mode, statusCode: response.status, ok: false, text: grokFailureMessage(response.status, text, response.headers.get("content-type") || undefined, account), stage: undefined };
        }
        if (!response.ok) {
          return { mode, statusCode: response.status, ok: false, text: grokFailureMessage(response.status, text, response.headers.get("content-type") || undefined, account), stage: undefined };
        }
        let payload: unknown = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          return { mode, statusCode: response.status, ok: true, text: "Grok rate-limits 返回内容不是合法 JSON", stage: undefined };
        }
        return { mode, statusCode: response.status, ok: true, text, stage: grokQuotaStage(mode.label, payload) };
      } catch (error) {
        return { mode, statusCode: 599, ok: false, text: upstreamNetworkErrorMessage(error, "Grok rate-limits 检查请求失败"), stage: undefined };
      }
    })
  );
  const stages = checks.map((item) => item.stage).filter((stage): stage is TemporaryAccountQuotaStage => Boolean(stage));
  const firstSuccess = checks.find((item) => item.ok);
  if (stages.length > 0) {
    const hasRemaining = stages.some((stage) => typeof stage.remaining !== "number" || stage.remaining > 0);
    const availability = hasRemaining ? "available" as const : "unavailable" as const;
    const errorMessage = hasRemaining ? undefined : "Grok 额度已耗尽或当前不允许请求";
    return {
      patch: {
        availability,
        quotaStages: stages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: firstSuccess?.statusCode,
        lastCheckError: errorMessage
      },
      result: {
        availability,
        status: hasRemaining ? "success" as const : "failed" as const,
        statusCode: firstSuccess?.statusCode,
        quotaStages: stages,
        errorMessage,
        checkedAt
      }
    };
  }

  const firstFailure = checks.find((item) => !item.ok);
  const failureText = checks.map((item) => item.text).join("\n");
  const statusCode = firstFailure?.statusCode;
  const errorMessage = extractUpstreamError(failureText) || (statusCode ? `HTTP ${statusCode}` : "Grok 检查失败");
  const invalidCredentials = checks.some((item) => [400, 401, 403].includes(item.statusCode) && grokInvalidCredentialsText(item.text));
  const browserEnvironmentIssue = checks.some((item) => item.statusCode === 403 || grokBrowserEnvironmentIssueText(item.text));
  const availability = invalidCredentials ? "unavailable" as const : "unknown" as const;
  const checkErrorMessage = browserEnvironmentIssue && !invalidCredentials
    ? `${errorMessage}；账号未判定不可用，请用导出 cf_clearance 的同一出口/防封 Docker 代理重试`
    : errorMessage;
  return {
    patch: {
      availability,
      quotaStages: existingQuotaStages,
      lastQuotaCheckedAt: checkedAt,
      lastCheckStatusCode: statusCode,
      lastCheckError: checkErrorMessage
    },
    result: {
      availability,
      status: "failed" as const,
      statusCode,
      quotaStages: existingQuotaStages,
      errorMessage: checkErrorMessage,
      checkedAt
    }
  };
}

async function checkTemporaryAccount(groupId: string, account: TemporaryAccount, proxyConfig?: RouteProxyConfig): Promise<TemporaryAccountCheckItemResult> {
  const checkedAt = new Date().toISOString();
  try {
    const accountIsCodex = account.accountType === "codex" || Boolean(account.accountId);
    const providerType = account.providerType || "gpt";
    const check = providerType === "grok"
      ? await checkGrokTemporaryAccount(account, checkedAt, proxyConfig)
      : accountIsCodex
        ? await checkCodexTemporaryAccount(account, checkedAt, proxyConfig)
        : await checkOpenAiApiKeyTemporaryAccount(account, checkedAt, proxyConfig);
    const updated = store.updateTemporaryAccountCheckResult(account.id, check.patch);
    return {
      groupId,
      accountId: account.id,
      label: account.label,
      availability: check.result.availability,
      status: check.result.status,
      statusCode: check.result.statusCode,
      quotaStages: updated?.quotaStages || check.result.quotaStages,
      errorMessage: check.result.errorMessage,
      checkedAt
    };
  } catch (error) {
    const errorMessage = upstreamNetworkErrorMessage(error, "账号检查请求上游失败");
    const providerType = account.providerType || "gpt";
    const availability = providerType === "grok" ? "unknown" : "unavailable";
    const updated = store.updateTemporaryAccountCheckResult(account.id, {
      availability,
      quotaStages: account.quotaStages,
      lastQuotaCheckedAt: checkedAt,
      lastCheckStatusCode: 599,
      lastCheckError: errorMessage
    });
    return {
      groupId,
      accountId: account.id,
      label: account.label,
      availability,
      status: "failed",
      statusCode: 599,
      quotaStages: updated?.quotaStages || account.quotaStages,
      errorMessage,
      checkedAt
    };
  }
}

function temporaryAccountCheckResult(results: TemporaryAccountCheckItemResult[]): TemporaryAccountCheckResult {
  return {
    total: results.length,
    available: results.filter((item) => item.availability === "available").length,
    unavailable: results.filter((item) => item.availability === "unavailable").length,
    unknown: results.filter((item) => item.availability === "unknown").length,
    results
  };
}

async function checkTemporaryAccounts(groupId?: string, proxyConfig?: RouteProxyConfig, providerType: TemporaryAccountProviderType = "gpt"): Promise<TemporaryAccountCheckResult> {
  const targets = store.temporaryAccountCheckTargets(groupId, providerType);
  if (groupId && targets.length === 0) throw new Error("临时账号组不存在");
  const results = await mapWithConcurrency(targets, TEMPORARY_ACCOUNT_CHECK_CONCURRENCY, ({ group, account }) =>
    checkTemporaryAccount(group.id, account, proxyConfig)
  );
  return temporaryAccountCheckResult(results);
}

async function checkTemporaryAccountIds(accountIds: string[], proxyConfig?: RouteProxyConfig, providerType?: TemporaryAccountProviderType): Promise<TemporaryAccountCheckResult> {
  const targets = accountIds.map((accountId) => store.temporaryAccountCheckTarget(accountId, providerType));
  if (targets.some((target) => !target)) throw new Error("临时账号不存在或不支持刷新");
  const validTargets = targets.filter((target): target is NonNullable<typeof target> => Boolean(target));
  const results = await mapWithConcurrency(validTargets, TEMPORARY_ACCOUNT_CHECK_CONCURRENCY, ({ group, account }) =>
    checkTemporaryAccount(group.id, account, proxyConfig)
  );
  return temporaryAccountCheckResult(results);
}

async function checkSingleTemporaryAccount(accountId: string, proxyConfig?: RouteProxyConfig): Promise<TemporaryAccountCheckResult> {
  return checkTemporaryAccountIds([accountId], proxyConfig);
}

function shouldMarkTemporaryAccountUnavailable(statusCode: number, errorMessage = "") {
  if ([401, 403, 429].includes(statusCode)) return true;
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("html") ||
    normalized.includes("chatgpt") ||
    normalized.includes("unauthorized") ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("usage_limit") ||
    normalized.includes("rate_limit") ||
    normalized.includes("quota") ||
    normalized.includes("额度")
  );
}

function markTemporaryAccountAttempt(candidate: ProxyExecutionCandidate, statusCode: number, errorMessage?: string) {
  const account = candidate.temporaryAccount || candidate.temporaryApiKeyAccount;
  if (!account) return;
  const checkedAt = new Date().toISOString();
  if (statusCode >= 200 && statusCode < 300 && !errorMessage) {
    store.updateTemporaryAccountCheckResult(account.id, {
      availability: "available",
      lastQuotaCheckedAt: checkedAt,
      lastCheckStatusCode: statusCode,
      lastCheckError: undefined
    });
    return;
  }
  if (account.providerType === "grok") {
    const message = errorMessage || `HTTP ${statusCode}`;
    if (statusCode === 401 || grokInvalidCredentialsText(message)) {
      store.updateTemporaryAccountCheckResult(account.id, {
        availability: "unavailable",
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: statusCode,
        lastCheckError: message
      });
      return;
    }
    if (statusCode === 403 || grokBrowserEnvironmentIssueText(message)) {
      store.updateTemporaryAccountCheckResult(account.id, {
        availability: "unknown",
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: statusCode,
        lastCheckError: `${message}；账号未判定不可用，请用导出 cf_clearance 的同一出口/防封 Docker 代理重试`
      });
      return;
    }
  }
  if (!shouldMarkTemporaryAccountUnavailable(statusCode, errorMessage)) return;
  store.updateTemporaryAccountCheckResult(account.id, {
    availability: "unavailable",
    lastQuotaCheckedAt: checkedAt,
    lastCheckStatusCode: statusCode,
    lastCheckError: errorMessage || `HTTP ${statusCode}`
  });
}

function codexTemporaryHeaders(account: TemporaryAccount, templateHeaders: Record<string, string>, stream: boolean) {
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

function codexTemporaryRequestBody(body: unknown, model: string) {
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

async function collectCodexResponsesBody(stream: ReadableStream<Uint8Array>) {
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

function unsupportedProxyMessage() {
  return "代理入口支持 /proxy、/proxy/v1/models、/proxy/v1/messages、/proxy/v1/chat/completions、/proxy/v1/responses 和 /proxy/v1beta/models/{model}:generateContent";
}

function proxyKindLabel(kind: ProxyKind, pathname: string) {
  if (kind === "generic") return "proxy";
  if (kind === "models") return "models";
  if (kind === "messages") return "messages";
  if (kind === "chat-completions") return "chat/completions";
  if (kind === "responses") return "responses";
  if (kind === "gemini-generate") return "gemini:generateContent";
  if (kind === "gemini-stream") return "gemini:streamGenerateContent";
  return pathname;
}

function routeCreatedSeconds(route: RouteRecord) {
  const timestamp = Date.parse(route.createdAt);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function wantsAnthropicModelsFormat(request: http.IncomingMessage, url: URL) {
  return Boolean(
    url.searchParams.get("format") === "anthropic" ||
      request.headers["anthropic-version"] ||
      request.headers["anthropic-beta"] ||
      request.headers["anthropic-dangerous-direct-browser-access"]
  );
}

function proxyModelsPayload(format: "anthropic" | "openai") {
  const data = store
    .getDb()
    .routes.filter((route) => route.enabled)
    .map((route) => {
      if (format === "anthropic") {
        return {
          type: "model",
          id: route.name,
          display_name: route.name,
          created_at: route.createdAt
        };
      }

      return {
        id: route.name,
        object: "model",
        type: "model",
        display_name: route.name,
        created: routeCreatedSeconds(route),
        created_at: route.createdAt,
        owned_by: "samapi",
        route_id: route.id,
        route_type: route.type,
        endpoint: route.endpoint,
        ...(route.type === "group"
          ? {
              strategy: route.strategy,
              match_rule: route.matchRule,
              member_count: route.members.length
            }
          : {
              site_id: route.siteId
            })
      };
    });

  const payload = {
    data,
    has_more: false,
    first_id: typeof data[0]?.id === "string" ? data[0].id : null,
    last_id: typeof data[data.length - 1]?.id === "string" ? data[data.length - 1].id : null
  };

  return format === "anthropic" ? payload : { object: "list", ...payload };
}

function chainSummary(input: {
  downstreamModel?: string;
  downstreamEndpoint?: string;
  downstreamUa?: string;
  routeModel?: string;
  routeEndpoint?: string;
  routeUa?: string;
  status: RequestLogStatus;
}) {
  return `下游 ${input.downstreamModel || "unknown"} (${input.downstreamEndpoint || "unknown"} / ${input.downstreamUa || "unknown ua"}) -> 路由目标 ${input.routeModel || "unknown"} (${input.routeEndpoint || "unknown"} / ${input.routeUa || "unknown ua"}) -> ${input.status === "success" ? "成功" : input.status === "pending" ? "请求中" : "失败"}`;
}

function headerKey(headers: Record<string, string>, name: string) {
  return Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
}

function headerValue(headers: Record<string, string>, name: string) {
  const key = headerKey(headers, name);
  return key ? headers[key].trim() : "";
}

function setHeader(headers: Record<string, string>, name: string, value: string) {
  const existingKey = headerKey(headers, name);
  headers[existingKey || name] = value;
}

function enabledSiteAddresses(site: Site) {
  return site.addresses.filter((address) => address.enabled);
}

function routeHeaderTemplate(route: SwitchRoute | GroupRoute) {
  return route.headerTemplateId ? store.getDb().headerTemplates.find((item) => item.id === route.headerTemplateId) : undefined;
}

function candidateKey(candidate: ProxyExecutionCandidate) {
  return `${candidate.site.id}::${candidate.providerApiKey?.id || candidate.temporaryAccount?.id || ""}::${candidate.model}`;
}

function candidateLogKey(candidate: ProxyExecutionCandidate) {
  return `${candidate.site.id}::${candidate.model}`;
}

function preferredStableCandidateKey(route: GroupRoute, candidates: ProxyExecutionCandidate[]) {
  const runtimeKey = routeRuntimeState.get(route.id)?.stableCandidateKey;
  if (runtimeKey && candidates.some((candidate) => candidateKey(candidate) === runtimeKey)) return runtimeKey;

  const recentSuccess = store
    .listRequestLogs()
    .find((log) => log.routeId === route.id && log.status === "success" && log.providerId && log.model);
  if (!recentSuccess?.providerId || !recentSuccess.model) return undefined;

  return candidates.find((candidate) => candidateLogKey(candidate) === `${recentSuccess.providerId}::${recentSuccess.model}`)
    ? `${recentSuccess.providerId}::${recentSuccess.model}`
    : undefined;
}

function orderedGroupCandidates(route: GroupRoute, candidates: ProxyExecutionCandidate[]) {
  if (route.strategy === "random") {
    const shuffled = [...candidates];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }
  if (route.strategy === "stable-first") {
    const preferredKey = preferredStableCandidateKey(route, candidates);
    if (!preferredKey) return candidates;
    const preferredIndex = candidates.findIndex(
      (candidate) => candidateKey(candidate) === preferredKey || candidateLogKey(candidate) === preferredKey
    );
    if (preferredIndex <= 0) return candidates;
    const preferred = candidates[preferredIndex];
    return [preferred, ...candidates.filter((_, index) => index !== preferredIndex)];
  }
  return candidates;
}

function markCandidateSuccess(route: RouteRecord, candidate: ProxyExecutionCandidate) {
  if (route.type !== "group" || route.strategy !== "stable-first") return;
  routeRuntimeState.set(route.id, {
    stableCandidateKey: candidateKey(candidate)
  });
}

function routeMemberKey(member: { siteId: string; apiKeyId: string; model: string }) {
  return `${member.siteId}::${member.apiKeyId}::${member.model}`;
}

function temporaryAccountProviderTypeForSite(site: Site) {
  const text = [site.name, ...site.addresses.map((address) => address.baseUrl)].join(" ").toLowerCase();
  if (text.includes("grok") || text.includes("x.ai")) return "grok" as const;
  return undefined;
}

function temporaryAccountProviderTypeForModel(model: string) {
  return model.toLowerCase().includes("grok") ? "grok" as const : undefined;
}

function resolveTemporaryProviderAccountsForRoute(site: Site, model: string) {
  const providerType = temporaryAccountProviderTypeForSite(site) || temporaryAccountProviderTypeForModel(model);
  if (!providerType) return [];
  return store.resolveTemporaryProviderAccounts(providerType, model);
}

function isCodexTemporaryAccount(account: TemporaryAccount) {
  return account.providerType === "gpt" && (account.accountType === "codex" || Boolean(account.accountId));
}

function resolveProxyExecution(routeNameOrId: string) {
  const db = store.getDb();
  const route = db.routes.find((item) => item.id === routeNameOrId || item.name === routeNameOrId);
  if (!route || !route.enabled) throw new Error("路由不存在或已停用");

  if (route.type === "switch") {
    const site = db.sites.find((item) => item.id === route.siteId);
    const addresses = site ? enabledSiteAddresses(site) : [];
    if (!site || addresses.length === 0) throw new Error("路由绑定的供应商地址不可用");
    const officialProviderApiKey = store.resolveProviderApiKey(site.id, route.model);
    const useChatGptOfficial = officialProviderApiKey?.kind === "chatgpt-official";
    const temporaryAccounts = useChatGptOfficial || store.isOfficialOpenAiSite(site.id)
      ? store.resolveTemporaryOpenAiAccounts(route.model)
      : resolveTemporaryProviderAccountsForRoute(site, route.model);
    if (temporaryAccounts.length > 0) {
      const candidates: ProxyExecutionCandidate[] = temporaryAccounts.map((temporaryAccount, index) => {
        const temporaryAccountIsCodex = isCodexTemporaryAccount(temporaryAccount);
        return {
          site,
          addresses,
          model: route.model,
          providerApiKey: temporaryAccountIsCodex || isGrokWebTemporaryAccount(temporaryAccount) ? undefined : temporaryAccount,
          temporaryAccount: temporaryAccountIsCodex ? temporaryAccount : undefined,
          temporaryApiKeyAccount: temporaryAccountIsCodex ? undefined : temporaryAccount,
          headerTemplate: routeHeaderTemplate(route),
          index
        };
      });
      return {
        route,
        candidates
      };
    }
    const candidates: ProxyExecutionCandidate[] = [
      {
        site,
        addresses,
        model: route.model,
        providerApiKey: officialProviderApiKey,
        headerTemplate: routeHeaderTemplate(route),
        index: 0
      }
    ];
    return {
      route,
      candidates
    };
  }

  const headerTemplate = routeHeaderTemplate(route);
  const candidates: ProxyExecutionCandidate[] = [];
  const usedMembers = new Set<string>();
  const members =
    route.members?.length > 0
      ? route.members
      : db.providerApiKeyGroups.flatMap((group) =>
          group.apiKeys.flatMap((apiKey) =>
            apiKey.models
              .filter((model) => model === route.modelGroupId)
              .map((model) => ({ siteId: group.siteId, apiKeyId: apiKey.id, model }))
          )
        );
  for (const member of members) {
    const memberKey = routeMemberKey(member);
    if (usedMembers.has(memberKey)) continue;
    usedMembers.add(memberKey);
    const site = db.sites.find((item) => item.id === member.siteId);
    if (!site) continue;
    const addresses = enabledSiteAddresses(site);
    if (addresses.length === 0) continue;
    const group = db.providerApiKeyGroups.find((item) => item.siteId === member.siteId && item.apiKeys.some((apiKey) => apiKey.id === member.apiKeyId));
    const apiKey = group?.apiKeys.find((item) => item.id === member.apiKeyId);
    if (!apiKey?.enabled || !apiKey.models.includes(member.model)) continue;
    if (apiKey.kind === "chatgpt-official") {
      for (const temporaryAccount of store.resolveTemporaryOpenAiAccounts(member.model)) {
        const temporaryAccountIsCodex = isCodexTemporaryAccount(temporaryAccount);
        candidates.push({
          site,
          addresses,
          model: member.model,
          providerApiKey: temporaryAccountIsCodex || isGrokWebTemporaryAccount(temporaryAccount) ? undefined : temporaryAccount,
          temporaryAccount: temporaryAccountIsCodex ? temporaryAccount : undefined,
          temporaryApiKeyAccount: temporaryAccountIsCodex ? undefined : temporaryAccount,
          headerTemplate,
          index: candidates.length
        });
      }
      continue;
    }
    candidates.push({
      site,
      addresses,
      model: member.model,
      providerApiKey: apiKey,
      headerTemplate,
      index: candidates.length
    });
  }
  if (candidates.length === 0) throw new Error(`分组路由 ${route.name} 没有可用模型`);
  return { route, candidates: orderedGroupCandidates(route, candidates) };
}

function looksLikeHtml(contentType: string | undefined, text: string) {
  const compact = text.trim().slice(0, 80).toLowerCase();
  return Boolean(contentType?.toLowerCase().includes("text/html") || compact.startsWith("<!doctype") || compact.startsWith("<html"));
}

function proxyEndpointCandidates(baseUrl: string, endpoint: string) {
  return [joinUrl(v1BaseUrl(baseUrl), endpoint)];
}

function modelEndpointCandidates(baseUrl: string) {
  return [joinUrl(v1BaseUrl(baseUrl), "models")];
}

function newApiPricingEndpointCandidates(baseUrl: string) {
  const candidates: string[] = [];
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (/\/v\d+$/i.test(pathname)) {
      parsed.pathname = pathname.replace(/\/v\d+$/i, "");
      candidates.push(joinUrl(parsed.toString(), "api/pricing"));
    }
  } catch {
    // Base URLs are validated before storage; keep the regular candidate if this ever fails.
  }
  candidates.push(joinUrl(baseUrl, "api/pricing"));
  return Array.from(new Set(candidates));
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

class ModelDiscoveryOptionsError extends Error {
  readonly modelGroups: Array<{ groupName: string; models: string[] }>;

  constructor(message: string, modelGroups: Array<{ groupName: string; models: string[] }>) {
    super(message);
    this.name = "ModelDiscoveryOptionsError";
    this.modelGroups = modelGroups;
  }
}

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
        kind: apiKey.kind || "api-key"
      }));
  });
  const results: ProviderModelSyncResult["results"] = [];

  for (const target of targets) {
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

function resolveLogContext(routeNameOrId: string): Partial<RequestLog> {
  const route = store.getDb().routes.find((item) => item.id === routeNameOrId || item.name === routeNameOrId);
  if (!route) {
    return {};
  }
  if (route.type === "group") {
    return {
      routeId: route.id,
      routeName: route.name,
      endpoint: route.endpoint,
      providerName: "分组路由",
      model: route.name
    };
  }
  const site = store.getDb().sites.find((item) => item.id === route.siteId);
  const firstAddress = site?.addresses.find((address) => address.enabled);
  return {
    routeId: route.id,
    routeName: route.name,
    endpoint: route.endpoint,
    providerName: site?.name,
    providerId: site?.id,
    addressLabel: firstAddress?.label,
    model: route.model,
    upstreamUrl: firstAddress ? proxyEndpointCandidates(firstAddress.baseUrl, route.endpoint)[0] : undefined
  };
}

async function handleApi(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method || "GET";

  if (method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  try {
    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, dataDir: store.dataDir, dbPath: store.dbPath, temporaryAccountsPath: store.temporaryAccountsPath });
      return;
    }

    if (parts[1] === "auth") {
      if (method === "GET" && parts[2] === "session") {
        if (!hasAdminSession(request)) {
          sendJson(response, 200, { authenticated: false });
          return;
        }
        const session = renewAdminSession(response);
        sendJson(response, 200, { authenticated: true, expiresAt: session.expiresAt });
        return;
      }
      if (method === "POST" && parts[2] === "login") {
        const body = await readJson(request);
        const password = typeof body.password === "string" ? body.password : "";
        if (!verifyAdminPassword(password)) {
          sendJson(response, 401, { error: "管理密码不正确" });
          return;
        }
        const session = createAdminSession();
        sendJson(
          response,
          200,
          { authenticated: true, expiresAt: session.expiresAt },
          { "Set-Cookie": adminSessionCookie(session.token) }
        );
        return;
      }
      if (method === "POST" && parts[2] === "logout") {
        sendJson(response, 200, { authenticated: false }, { "Set-Cookie": clearAdminSessionCookie() });
        return;
      }
    }

    if (!requireAdminSession(request, response, url)) return;

    if (method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, {
        dbPath: store.sqlitePath,
        dataDir: store.dataDir,
        endpoints: ["messages", "chat/completions", "responses"],
        security: {
          adminPasswordCustomized: Boolean(store.getDb().adminPasswordHash)
        }
      });
      return;
    }

    if (parts[1] === "settings") {
      if (method === "GET") return sendJson(response, 200, store.getDb().settings);
      if (method === "PATCH") return sendJson(response, 200, store.updateSettings(await readJson(request)));
    }

    if (parts[1] === "auth" && method === "POST" && parts[2] === "password") {
      const body = await readJson(request);
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const nextPassword = typeof body.nextPassword === "string" ? body.nextPassword : "";
      if (!verifyAdminPassword(currentPassword)) return sendJson(response, 401, { error: "当前管理密码不正确" });
      store.updateAdminPasswordHash(nextPassword);
      return sendJson(response, 200, { authenticated: false }, { "Set-Cookie": clearAdminSessionCookie() });
    }

    if (parts[1] === "logs") {
      if (method === "GET" && parts[2]) {
        const log = store.getRequestLog(routeParam(parts, 2));
        if (!log) return sendJson(response, 404, { error: "日志不存在" });
        return sendJson(response, 200, log);
      }
      if (method === "GET") {
        const requestedLimit = Number(url.searchParams.get("limit") || "");
        const requestedOffset = Number(url.searchParams.get("offset") || "");
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(100, Math.floor(requestedLimit)) : 5;
        const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset) : 0;
        const since = url.searchParams.get("since") || "";
        const items = since ? store.listNewRequestLogs(since, limit) : store.listRequestLogs(limit, offset);
        return sendJson(response, 200, {
          items,
          total: store.requestLogCount(),
          limit,
          offset: since ? 0 : offset
        });
      }
      if (method === "DELETE" && parts[2] === "clear") {
        store.clearRequestLogs();
        return sendJson(response, 200, { ok: true });
      }
      if (method === "DELETE") {
        store.deleteRequestLog(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "sites") {
      if (method === "GET") return sendJson(response, 200, store.getDb().sites);
      if (method === "POST") return sendJson(response, 201, store.upsertSite(await readJson(request)));
      if (method === "PATCH") return sendJson(response, 200, store.upsertSite({ ...(await readJson(request)), id: routeParam(parts, 2) }));
      if (method === "DELETE") {
        store.deleteSite(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "keys") {
      if (method === "GET") return sendJson(response, 200, store.getDb().apiKeys);
      if (method === "POST") {
        const body = await readJson(request) as { name?: unknown; models?: unknown };
        return sendJson(response, 201, store.createApiKey(String(body.name || ""), Array.isArray(body.models) ? body.models.map(String) : []));
      }
      if (method === "PATCH") return sendJson(response, 200, store.updateApiKey(routeParam(parts, 2), await readJson(request)));
      if (method === "DELETE") {
        store.deleteApiKey(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "provider-key-groups") {
      if (method === "POST" && parts[2] === "discover-models") {
        const body = await readJson(request);
        return sendJson(
          response,
          200,
          await discoverProviderModels(String(body.siteId || ""), String(body.apiKey || ""), String(body.apiKeyName || ""), request, String(body.kind || "api-key"))
        );
      }
      if (method === "POST" && parts[2] === "sync-models") return sendJson(response, 200, await syncAllProviderModels(request));
      if (method === "GET") return sendJson(response, 200, store.listProviderApiKeyGroups());
      if (method === "POST") return sendJson(response, 201, store.upsertProviderApiKeyGroup(await readJson(request)));
      if (method === "DELETE") {
        store.deleteProviderApiKeyGroup(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "temporary-accounts") {
      if (method === "GET") return sendJson(response, 200, store.getDb().temporaryAccountGroups);
      if (method === "POST" && parts[2] === "import") {
        const body = await readJson(request);
        const imported = store.importTemporaryAccounts(body);
        const checkProxy = temporaryAccountCheckProxyFromBody(body);
        const checkResult = ["gpt", "grok"].includes(imported.group.providerType || "")
          ? await checkTemporaryAccountIds(imported.accountIds, checkProxy, imported.group.providerType)
          : undefined;
        const updatedGroup = store.getDb().temporaryAccountGroups.find((group) => group.id === imported.group.id) || imported.group;
        return sendJson(response, 201, { ...imported, group: updatedGroup, checkResult });
      }
      if (method === "POST" && parts[2] === "check") {
        const body = await readJson(request);
        return sendJson(response, 200, await checkTemporaryAccounts(undefined, temporaryAccountCheckProxyFromBody(body), temporaryAccountProviderTypeFromBody(body)));
      }
      if (method === "DELETE" && parts[2] === "batch") {
        const body = await readJson(request);
        store.deleteTemporaryAccounts(Array.isArray(body.ids) ? body.ids.map(String) : []);
        return sendJson(response, 200, { ok: true });
      }
      if (parts[2] === "accounts") {
        const accountId = routeParam(parts, 3);
        if (method === "POST" && parts[4] === "check") {
          const body = await readJson(request);
          return sendJson(response, 200, await checkSingleTemporaryAccount(accountId, temporaryAccountCheckProxyFromBody(body)));
        }
        if (method === "PATCH") return sendJson(response, 200, store.updateTemporaryAccount(accountId, await readJson(request)));
        if (method === "DELETE") {
          store.deleteTemporaryAccount(accountId);
          return sendJson(response, 200, { ok: true });
        }
      }
      if (method === "PATCH") return sendJson(response, 200, store.updateTemporaryAccountGroup(routeParam(parts, 2), await readJson(request)));
      if (method === "DELETE") {
        store.deleteTemporaryAccountGroup(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "headers") {
      if (method === "GET") return sendJson(response, 200, store.getDb().headerTemplates);
      if (method === "POST") return sendJson(response, 201, store.upsertHeaderTemplate(await readJson(request)));
      if (method === "PATCH") return sendJson(response, 200, store.upsertHeaderTemplate({ ...(await readJson(request)), id: routeParam(parts, 2) }));
      if (method === "DELETE") {
        store.deleteHeaderTemplate(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "routes") {
      if (method === "GET") return sendJson(response, 200, store.getDb().routes);
      if (method === "POST") return sendJson(response, 201, store.upsertRoute(await readJson(request)));
      if (method === "PATCH") return sendJson(response, 200, store.upsertRoute({ ...(await readJson(request)), id: routeParam(parts, 2) }));
      if (method === "DELETE") {
        store.deleteRoute(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    notFound(response);
  } catch (error) {
    if (error instanceof ModelDiscoveryOptionsError) {
      sendJson(response, 400, { error: error.message, modelGroups: error.modelGroups });
      return;
    }
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request" });
  }
}

async function handleProxy(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const startedAt = Date.now();
  const baseLog = {
    routeName: "unknown",
    method: request.method || "POST",
    path: url.pathname,
    providerName: "未匹配",
    model: "未匹配",
    userAgent: valueToHeaderText(request.headers["user-agent"]),
    clientIp: request.socket.remoteAddress || "",
    requestHeaders: maskRequestHeaders(request.headers)
  };

  if (request.method === "HEAD") {
    store.recordRequestLog({
      ...baseLog,
      routeName: "proxy-healthcheck",
      providerName: "健康检查",
      model: "健康检查",
      requestBody: undefined,
      status: "success",
      statusCode: 200,
      durationMs: Date.now() - startedAt
    });
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*"
    });
    response.end();
    return;
  }

  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    store.recordRequestLog({
      ...baseLog,
      requestBody: undefined,
      status: "failed",
      statusCode: 400,
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : "Invalid JSON"
    });
    sendJson(response, 400, { error: "Invalid JSON body" });
    return;
  }

  const proxyInfo = proxyPathInfo(url.pathname);
  const routeNameOrId = proxyRouteName(url.pathname, body);
  const downstreamEndpoint = proxyKindLabel(proxyInfo.kind, url.pathname);
  const downstreamUa = valueToHeaderText(request.headers["user-agent"]);
  const routeLogContext = resolveLogContext(routeNameOrId);
  const requestLogBase = {
    ...baseLog,
    routeName: proxyInfo.kind === "models" ? "proxy-models" : routeNameOrId || "unknown"
  };
  const downstreamLog = {
    model: proxyInfo.kind === "models" ? "模型列表" : routeNameOrId || requestModelName(body) || "unknown",
    endpoint: downstreamEndpoint,
    userAgent: downstreamUa,
    path: url.pathname,
    method: request.method || "POST"
  };

  const apiKey = requestApiKey(request, url);
  const authenticatedApiKey = store.verifyApiKey(apiKey);
  if (!authenticatedApiKey) {
    store.recordRequestLog({
      ...requestLogBase,
      ...routeLogContext,
      requestBody: body,
      status: "failed",
      statusCode: 401,
      durationMs: Date.now() - startedAt,
      errorMessage: "Invalid API key"
    });
    sendJson(response, 401, { error: "Invalid API key" });
    return;
  }

  if (proxyInfo.kind === "models") {
    if (request.method !== "GET") {
      store.recordRequestLog({
        ...requestLogBase,
        routeName: "proxy-models",
        providerName: "模型列表",
        model: "模型列表",
        requestBody: body,
        status: "failed",
        statusCode: 405,
        durationMs: Date.now() - startedAt,
        errorMessage: "Models endpoint only supports GET",
        downstream: downstreamLog
      });
      sendJson(response, 405, { error: "Models endpoint only supports GET" });
      return;
    }

    const modelsFormat = wantsAnthropicModelsFormat(request, url) ? "anthropic" : "openai";
    const payload = proxyModelsPayload(modelsFormat);
    if (authenticatedApiKey !== true && authenticatedApiKey.models.length > 0) {
      const allowed = new Set(authenticatedApiKey.models);
      payload.data = payload.data.filter((item) => allowed.has(item.id));
    }
    const modelIds = payload.data.map((item) => item.id).filter((item): item is string => typeof item === "string");
    store.recordRequestLog({
      ...requestLogBase,
      routeName: "proxy-models",
      providerName: "模型列表",
      model: "模型列表",
      requestBody: undefined,
      status: "success",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      responsePreview: responsePreview(JSON.stringify({ modelCount: modelIds.length, models: modelIds.slice(0, 80) }, null, 2)),
      downstream: downstreamLog,
      summary: `下游 models (${url.pathname} / ${downstreamUa || "unknown ua"}) -> 返回 ${modelIds.length} 个可用模型 (${modelsFormat})`
    });
    sendJson(response, 200, payload);
    return;
  }

  try {
    if (!routeNameOrId) throw new Error("请求体中的 model 必须填写路由名称");
    if (authenticatedApiKey !== true && authenticatedApiKey.models.length > 0 && !authenticatedApiKey.models.includes(routeNameOrId)) {
      throw new Error(`当前客户端密钥不允许使用模型 ${routeNameOrId}`);
    }
    const { route, candidates } = resolveProxyExecution(routeNameOrId);
    const downstreamStream = isStreamingRequest(body) || proxyInfo.kind === "gemini-stream";

    const errors: string[] = [];
    let lastFailure:
      | {
          address: SiteAddress;
          target: string;
          statusCode: number;
          text?: string;
          contentType?: string;
        }
      | undefined;
    let lastAttemptContext:
      | {
          candidate: ProxyExecutionCandidate;
          routeUa: string;
          routeTargetLog: RequestLog["routeTarget"];
          upstreamAuthLog: Record<string, string>;
        }
      | undefined;
    const upstreamAttempts: NonNullable<RequestLog["upstreamAttempts"]> = [];

    for (const candidate of candidates) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...parseHeaderTemplate(candidate.headerTemplate?.headersText)
      };
      if (!candidate.providerApiKey && !candidate.temporaryAccount && !candidate.temporaryApiKeyAccount && !headerValue(headers, "Authorization")) {
        throw new Error(`未找到支持模型 ${candidate.model} 的上游 API Key`);
      }
      if (candidate.providerApiKey) setHeader(headers, "Authorization", `Bearer ${candidate.providerApiKey.secret}`);
      const routeUa = headerValue(headers, "User-Agent") || "fetch default";
      const routeTargetLog = {
        routeName: route.name,
        model: candidate.model,
        endpoint: route.endpoint,
        providerName: candidate.site.name,
        userAgent: routeUa
      };
      const upstreamAuthLog: Record<string, string> = candidate.providerApiKey
        ? {
            "upstream-api-key": candidate.providerApiKey.label,
            "upstream-authorization": `Bearer ${maskSecret(candidate.providerApiKey.secret)}`
          }
        : candidate.temporaryAccount
          ? {
              "upstream-api-key": candidate.temporaryAccount.label,
              "upstream-authorization": `Bearer ${maskSecret(candidate.temporaryAccount.secret)}`
            }
        : candidate.temporaryApiKeyAccount
          ? {
              "upstream-api-key": candidate.temporaryApiKeyAccount.label,
              "upstream-authorization": candidate.temporaryApiKeyAccount.providerType === "grok" ? "Grok Web SSO Cookie" : `Bearer ${maskSecret(candidate.temporaryApiKeyAccount.secret)}`
            }
        : {
            "upstream-authorization": "Header 模版已提供"
      };
      const converted = convertedRouteRequestBody(body, candidate.model, route.endpoint, proxyInfo.kind);
      const responseConverter = converted.converter;
      const sanitizedBody = sanitizeOpenAiCompatibleResponsesBody(converted.body, route.endpoint);
      const forwardedBody = downstreamStream ? applyStreamingFlag(sanitizedBody, true) : sanitizedBody;
      const upstreamRequestHeaders = {
        ...maskedStringHeaders(headers),
        ...upstreamAuthLog
      };
      lastAttemptContext = { candidate, routeUa, routeTargetLog, upstreamAuthLog };

      if (isGrokWebTemporaryAccount(candidate.temporaryApiKeyAccount)) {
        const grokAccount = candidate.temporaryApiKeyAccount;
        const grokHeaders = grokTemporaryHeaders(grokAccount, headers);
        const grokRouteUa = headerValue(grokHeaders, "User-Agent") || "Grok Web";
        const grokRouteTargetLog = {
          ...routeTargetLog,
          userAgent: grokRouteUa
        };
        const grokAuthLog: Record<string, string> = {
          "upstream-api-key": grokAccount.label,
          "upstream-authorization": "Grok Web SSO Cookie"
        };
        lastAttemptContext = { candidate, routeUa: grokRouteUa, routeTargetLog: grokRouteTargetLog, upstreamAuthLog: grokAuthLog };
        const convertedForGrok = convertedRouteRequestBody(body, candidate.model, "chat/completions", proxyInfo.kind);
        const grokForwardedBody = grokWebRequestBody(convertedForGrok.body, candidate.model);
        const grokUpstreamRequestHeaders = {
          ...maskedStringHeaders(grokHeaders),
          ...grokAuthLog,
          "grok-cookie-state": grokCookieDiagnosticText(grokAccount)
        };
        const attemptStartedAt = Date.now();
        try {
          const { response: upstream, proxy: attemptProxy } = await fetchWithRouteProxy(GROK_CONVERSATIONS_NEW_URL, {
            method: "POST",
            headers: grokHeaders,
            body: JSON.stringify(grokForwardedBody)
          }, route.proxy);
          const contentType = upstream.headers.get("content-type") || undefined;
          const text = upstream.body ? await collectGrokWebStreamBody(upstream.body) : await upstream.text();

          if (upstream.ok && !looksLikeHtml(contentType, text)) {
            const adapted = adaptGrokWebResponseText(text, proxyInfo.kind, candidate.model, convertedForGrok.converter, downstreamStream);
            upstreamAttempts.push({
              addressLabel: "Grok Web",
              upstreamUrl: GROK_CONVERSATIONS_NEW_URL,
              method: "POST",
              model: candidate.model,
              endpoint: "chat/completions",
              userAgent: grokRouteUa,
              requestHeaders: grokUpstreamRequestHeaders,
              requestBody: grokForwardedBody,
              status: "success",
              statusCode: upstream.status,
              durationMs: Date.now() - attemptStartedAt,
              contentType,
              responsePreview: responsePreview(adapted.text || text)
            });
            store.recordRequestLog({
              ...requestLogBase,
              routeId: route.id,
              routeName: route.name,
              endpoint: route.endpoint,
              providerName: candidate.site.name,
              providerId: candidate.site.id,
              addressLabel: "Grok Web",
              model: candidate.model,
              requestBody: body,
              status: "success",
              statusCode: upstream.status,
              durationMs: Date.now() - startedAt,
              requestHeaders: {
                ...requestLogBase.requestHeaders,
                ...grokAuthLog
              },
              upstreamUrl: GROK_CONVERSATIONS_NEW_URL,
              upstreamContentType: contentType,
              responsePreview: responsePreview(adapted.text || text),
              downstream: downstreamLog,
              routeTarget: grokRouteTargetLog,
              upstreamAttempts,
              proxy: attemptProxy,
              summary: chainSummary({
                downstreamModel: downstreamLog.model,
                downstreamEndpoint,
                downstreamUa,
                routeModel: candidate.model,
                routeEndpoint: route.endpoint,
                routeUa: grokRouteUa,
                status: "success"
              })
            });
            markTemporaryAccountAttempt(candidate, upstream.status);
            markCandidateSuccess(route, candidate);
            response.writeHead(upstream.status, {
              "Content-Type": adapted.contentType || "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*"
            });
            response.end(adapted.text);
            return;
          }

          const errorMessage = grokFailureMessage(upstream.status, text, contentType, grokAccount);
          markTemporaryAccountAttempt(candidate, upstream.status, errorMessage);
          errors.push(`Grok Web：${upstream.status} ${errorMessage}`);
          upstreamAttempts.push({
            addressLabel: "Grok Web",
            upstreamUrl: GROK_CONVERSATIONS_NEW_URL,
            method: "POST",
            model: candidate.model,
            endpoint: "chat/completions",
            userAgent: grokRouteUa,
            requestHeaders: grokUpstreamRequestHeaders,
            requestBody: grokForwardedBody,
            status: "failed",
            statusCode: upstream.status,
            durationMs: Date.now() - attemptStartedAt,
            contentType,
            responsePreview: responsePreview(text),
            errorMessage
          });
          lastFailure = {
            address: candidate.addresses[0],
            target: GROK_CONVERSATIONS_NEW_URL,
            statusCode: upstream.status,
            text,
            contentType
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "请求 Grok Web 上游失败";
          markTemporaryAccountAttempt(candidate, 599, errorMessage);
          errors.push(`Grok Web：${errorMessage}`);
          upstreamAttempts.push({
            addressLabel: "Grok Web",
            upstreamUrl: GROK_CONVERSATIONS_NEW_URL,
            method: "POST",
            model: candidate.model,
            endpoint: "chat/completions",
            userAgent: grokRouteUa,
            requestHeaders: grokUpstreamRequestHeaders,
            requestBody: grokForwardedBody,
            status: "failed",
            statusCode: 599,
            durationMs: Date.now() - attemptStartedAt,
            responsePreview: responsePreview(JSON.stringify({ error: errorMessage })),
            errorMessage
          });
        }
        continue;
      }

      if (candidate.temporaryAccount) {
        const codexHeaders = codexTemporaryHeaders(candidate.temporaryAccount, headers, true);
        const codexRouteUa = headerValue(codexHeaders, "User-Agent") || CODEX_USER_AGENT;
        const codexRouteTargetLog = {
          ...routeTargetLog,
          userAgent: codexRouteUa
        };
        const codexAuthLog: Record<string, string> = {
          "upstream-api-key": candidate.temporaryAccount.label,
          "upstream-authorization": `Bearer ${maskSecret(candidate.temporaryAccount.secret)}`,
          "upstream-account-id": candidate.temporaryAccount.accountId ? maskSecret(candidate.temporaryAccount.accountId) : "未提供"
        };
        lastAttemptContext = { candidate, routeUa: codexRouteUa, routeTargetLog: codexRouteTargetLog, upstreamAuthLog: codexAuthLog };
        const convertedForCodex = convertedRouteRequestBody(body, candidate.model, "responses", proxyInfo.kind);
        const codexForwardedBody = codexTemporaryRequestBody(convertedForCodex.body, candidate.model);
        const codexUpstreamRequestHeaders = {
          ...maskedStringHeaders(codexHeaders),
          ...codexAuthLog
        };
        const attemptStartedAt = Date.now();
        try {
          const { response: upstream, proxy: attemptProxy } = await fetchWithRouteProxy(CODEX_BACKEND_RESPONSES_URL, {
            method: "POST",
            headers: codexHeaders,
            body: JSON.stringify(codexForwardedBody)
          }, route.proxy);
          const contentType = upstream.headers.get("content-type") || undefined;

          if (upstream.ok && upstream.body && !looksLikeHtml(contentType, "")) {
            if (downstreamStream) {
              response.socket?.setNoDelay(true);
              response.writeHead(upstream.status, {
                "Content-Type": streamResponseContentType(proxyInfo.kind, contentType),
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
                "Access-Control-Allow-Origin": "*"
              });
              response.flushHeaders();
              const streamLog = store.recordRequestLog({
                ...requestLogBase,
                routeId: route.id,
                routeName: route.name,
                endpoint: route.endpoint,
                providerName: candidate.site.name,
                providerId: candidate.site.id,
                addressLabel: "Codex Backend",
                model: candidate.model,
                requestBody: body,
                status: "pending",
                statusCode: upstream.status,
                durationMs: Date.now() - startedAt,
                requestHeaders: {
                  ...requestLogBase.requestHeaders,
                  ...codexAuthLog
                },
                upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                upstreamContentType: contentType,
                downstream: downstreamLog,
                routeTarget: codexRouteTargetLog,
                upstreamAttempts,
                proxy: attemptProxy,
                summary: chainSummary({
                  downstreamModel: downstreamLog.model,
                  downstreamEndpoint,
                  downstreamUa,
                  routeModel: candidate.model,
                  routeEndpoint: route.endpoint,
                  routeUa: codexRouteUa,
                  status: "pending"
                })
              });
              try {
                const streamPreviewText =
                  convertedForCodex.converter?.convertStream
                    ? await streamConvertedResponse({
                        upstreamBody: upstream.body,
                        response,
                        proxyKind: proxyInfo.kind,
                        routeEndpoint: "responses",
                        routeModel: candidate.model,
                        requestBody: codexForwardedBody,
                        converter: convertedForCodex.converter
                      })
                    : await streamRawResponse({ upstreamBody: upstream.body, response });
                response.end();
                upstreamAttempts.push({
                  addressLabel: "Codex Backend",
                  upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                  method: "POST",
                  model: candidate.model,
                  endpoint: "responses",
                  userAgent: codexRouteUa,
                  requestHeaders: codexUpstreamRequestHeaders,
                  requestBody: codexForwardedBody,
                  status: "success",
                  statusCode: upstream.status,
                  durationMs: Date.now() - attemptStartedAt,
                  contentType,
                  responsePreview: responsePreview(streamPreviewText)
                });
                store.updateRequestLog(streamLog.id, {
                  ...requestLogBase,
                  routeId: route.id,
                  routeName: route.name,
                  endpoint: route.endpoint,
                  providerName: candidate.site.name,
                  providerId: candidate.site.id,
                  addressLabel: "Codex Backend",
                  model: candidate.model,
                  requestBody: body,
                  status: "success",
                  statusCode: upstream.status,
                  durationMs: Date.now() - startedAt,
                  requestHeaders: {
                    ...requestLogBase.requestHeaders,
                    ...codexAuthLog
                  },
                  upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                  upstreamContentType: contentType,
                  responsePreview: responsePreview(streamPreviewText),
                  downstream: downstreamLog,
                  routeTarget: codexRouteTargetLog,
                  upstreamAttempts,
                  proxy: attemptProxy,
                  summary: chainSummary({
                    downstreamModel: downstreamLog.model,
                    downstreamEndpoint,
                    downstreamUa,
                    routeModel: candidate.model,
                    routeEndpoint: route.endpoint,
                    routeUa: codexRouteUa,
                    status: "success"
                  })
                });
                markTemporaryAccountAttempt(candidate, upstream.status);
                markCandidateSuccess(route, candidate);
                return;
              } catch (streamError) {
                const errorMessage = streamError instanceof Error ? streamError.message : "Codex 流式转发失败";
                markTemporaryAccountAttempt(candidate, 599, errorMessage);
                upstreamAttempts.push({
                  addressLabel: "Codex Backend",
                  upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                  method: "POST",
                  model: candidate.model,
                  endpoint: "responses",
                  userAgent: codexRouteUa,
                  requestHeaders: codexUpstreamRequestHeaders,
                  requestBody: codexForwardedBody,
                  status: "failed",
                  statusCode: 599,
                  durationMs: Date.now() - attemptStartedAt,
                  contentType,
                  responsePreview: responsePreview(JSON.stringify({ error: errorMessage })),
                  errorMessage
                });
                store.updateRequestLog(streamLog.id, {
                  ...requestLogBase,
                  routeId: route.id,
                  routeName: route.name,
                  endpoint: route.endpoint,
                  providerName: candidate.site.name,
                  providerId: candidate.site.id,
                  addressLabel: "Codex Backend",
                  model: candidate.model,
                  requestBody: body,
                  status: "failed",
                  statusCode: 599,
                  durationMs: Date.now() - startedAt,
                  requestHeaders: {
                    ...requestLogBase.requestHeaders,
                    ...codexAuthLog
                  },
                  upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                  upstreamContentType: contentType,
                  responsePreview: responsePreview(JSON.stringify({ error: errorMessage })),
                  errorMessage,
                  downstream: downstreamLog,
                  routeTarget: codexRouteTargetLog,
                  upstreamAttempts,
                  proxy: attemptProxy,
                  summary: chainSummary({
                    downstreamModel: downstreamLog.model,
                    downstreamEndpoint,
                    downstreamUa,
                    routeModel: candidate.model,
                    routeEndpoint: route.endpoint,
                    routeUa: codexRouteUa,
                    status: "failed"
                  })
                });
                response.end();
                return;
              }
            }

            const codexCollected = await collectCodexResponsesBody(upstream.body);
            const adapted = convertUpstreamResponseText({
              text: codexCollected.text,
              contentType: "application/json; charset=utf-8",
              proxyKind: proxyInfo.kind,
              converter: convertedForCodex.converter,
              downstreamStream
            });
            upstreamAttempts.push({
              addressLabel: "Codex Backend",
              upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
              method: "POST",
              model: candidate.model,
              endpoint: "responses",
              userAgent: codexRouteUa,
              requestHeaders: codexUpstreamRequestHeaders,
              requestBody: codexForwardedBody,
              status: "success",
              statusCode: upstream.status,
              durationMs: Date.now() - attemptStartedAt,
              contentType,
              responsePreview: responsePreview(adapted.text || codexCollected.preview)
            });
            store.recordRequestLog({
              ...requestLogBase,
              routeId: route.id,
              routeName: route.name,
              endpoint: route.endpoint,
              providerName: candidate.site.name,
              providerId: candidate.site.id,
              addressLabel: "Codex Backend",
              model: candidate.model,
              requestBody: body,
              status: "success",
              statusCode: upstream.status,
              durationMs: Date.now() - startedAt,
              requestHeaders: {
                ...requestLogBase.requestHeaders,
                ...codexAuthLog
              },
              upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
              upstreamContentType: contentType,
              responsePreview: responsePreview(adapted.text || codexCollected.preview),
              downstream: downstreamLog,
              routeTarget: codexRouteTargetLog,
              upstreamAttempts,
              proxy: attemptProxy,
              summary: chainSummary({
                downstreamModel: downstreamLog.model,
                downstreamEndpoint,
                downstreamUa,
                routeModel: candidate.model,
                routeEndpoint: route.endpoint,
                routeUa: codexRouteUa,
                status: "success"
              })
            });
            markTemporaryAccountAttempt(candidate, upstream.status);
            markCandidateSuccess(route, candidate);
            response.writeHead(upstream.status, {
              "Content-Type": adapted.contentType || "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*"
            });
            response.end(adapted.text);
            return;
          }

          const text = await upstream.text();
          const htmlMessage = looksLikeHtml(contentType, text) ? "返回了 HTML 页面，请检查 Codex 账号、代理或 ChatGPT 访问状态" : "";
          const errorMessage = htmlMessage || extractUpstreamError(text) || `HTTP ${upstream.status}`;
          markTemporaryAccountAttempt(candidate, upstream.status, errorMessage);
          errors.push(`Codex Backend：${upstream.status} ${errorMessage}`);
          upstreamAttempts.push({
            addressLabel: "Codex Backend",
            upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
            method: "POST",
            model: candidate.model,
            endpoint: "responses",
            userAgent: codexRouteUa,
            requestHeaders: codexUpstreamRequestHeaders,
            requestBody: codexForwardedBody,
            status: "failed",
            statusCode: upstream.status,
            durationMs: Date.now() - attemptStartedAt,
            contentType,
            responsePreview: responsePreview(text),
            errorMessage
          });
          lastFailure = {
            address: candidate.addresses[0],
            target: CODEX_BACKEND_RESPONSES_URL,
            statusCode: upstream.status,
            text,
            contentType
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "请求 Codex 上游失败";
          markTemporaryAccountAttempt(candidate, 599, errorMessage);
          errors.push(`Codex Backend：${errorMessage}`);
          upstreamAttempts.push({
            addressLabel: "Codex Backend",
            upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
            method: "POST",
            model: candidate.model,
            endpoint: "responses",
            userAgent: codexRouteUa,
            requestHeaders: codexUpstreamRequestHeaders,
            requestBody: codexForwardedBody,
            status: "failed",
            statusCode: 599,
            durationMs: Date.now() - attemptStartedAt,
            responsePreview: responsePreview(JSON.stringify({ error: errorMessage })),
            errorMessage
          });
        }
        continue;
      }

      for (const address of candidate.addresses) {
      for (const target of proxyEndpointCandidates(address.baseUrl, route.endpoint)) {
        const attemptStartedAt = Date.now();
        try {
          const { response: upstream, proxy: attemptProxy } = await fetchWithRouteProxy(target, {
            method: request.method || "POST",
            headers,
            body: JSON.stringify(forwardedBody)
          }, route.proxy);
          const contentType = upstream.headers.get("content-type") || undefined;

          if (upstream.ok && !looksLikeHtml(contentType, "")) {
            if (downstreamStream && upstream.body) {
              response.socket?.setNoDelay(true);
              response.writeHead(upstream.status, {
                "Content-Type": streamResponseContentType(proxyInfo.kind, contentType),
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
                "Access-Control-Allow-Origin": "*"
              });
              response.flushHeaders();
              const streamLog = store.recordRequestLog({
                ...requestLogBase,
                routeId: route.id,
                routeName: route.name,
                endpoint: route.endpoint,
                providerName: candidate.site.name,
                providerId: candidate.site.id,
                addressLabel: address.label,
                model: candidate.model,
                requestBody: body,
                status: "pending",
                statusCode: upstream.status,
                durationMs: Date.now() - startedAt,
                requestHeaders: {
                  ...requestLogBase.requestHeaders,
                  ...upstreamAuthLog
                },
                upstreamUrl: target,
                upstreamContentType: contentType,
                downstream: downstreamLog,
                routeTarget: routeTargetLog,
                upstreamAttempts,
                proxy: attemptProxy,
                summary: chainSummary({
                  downstreamModel: downstreamLog.model,
                  downstreamEndpoint,
                  downstreamUa,
                  routeModel: candidate.model,
                  routeEndpoint: route.endpoint,
                  routeUa,
                  status: "pending"
                })
              });
              try {
                const streamPreviewText =
                  responseConverter?.convertStream
                    ? await streamConvertedResponse({
                        upstreamBody: upstream.body,
                        response,
                        proxyKind: proxyInfo.kind,
                        routeEndpoint: route.endpoint,
                        routeModel: candidate.model,
                        requestBody: forwardedBody,
                        converter: responseConverter
                      })
                    : await streamRawResponse({ upstreamBody: upstream.body, response });
                response.end();
                upstreamAttempts.push({
                  addressLabel: address.label,
                  upstreamUrl: target,
                  method: request.method || "POST",
                  model: candidate.model,
                  endpoint: route.endpoint,
                  userAgent: routeUa,
                  requestHeaders: upstreamRequestHeaders,
                  requestBody: forwardedBody,
                  status: "success",
                  statusCode: upstream.status,
                  durationMs: Date.now() - attemptStartedAt,
                  contentType,
                  responsePreview: responsePreview(streamPreviewText)
                });
                store.updateRequestLog(streamLog.id, {
                  ...requestLogBase,
                  routeId: route.id,
                  routeName: route.name,
                  endpoint: route.endpoint,
                  providerName: candidate.site.name,
                  providerId: candidate.site.id,
                  addressLabel: address.label,
                  model: candidate.model,
                  requestBody: body,
                  status: "success",
                  statusCode: upstream.status,
                  durationMs: Date.now() - startedAt,
                  requestHeaders: {
                    ...requestLogBase.requestHeaders,
                    ...upstreamAuthLog
                  },
                  upstreamUrl: target,
                  upstreamContentType: contentType,
                  responsePreview: responsePreview(streamPreviewText),
                  downstream: downstreamLog,
                  routeTarget: routeTargetLog,
                  upstreamAttempts,
                  proxy: attemptProxy,
                  summary: chainSummary({
                    downstreamModel: downstreamLog.model,
                    downstreamEndpoint,
                    downstreamUa,
                    routeModel: candidate.model,
                    routeEndpoint: route.endpoint,
                    routeUa,
                    status: "success"
                  })
                });
                markTemporaryAccountAttempt(candidate, upstream.status);
                markCandidateSuccess(route, candidate);
                return;
              } catch (streamError) {
                const errorMessage = streamError instanceof Error ? streamError.message : "流式转发失败";
                markTemporaryAccountAttempt(candidate, 599, errorMessage);
                upstreamAttempts.push({
                  addressLabel: address.label,
                  upstreamUrl: target,
                  method: request.method || "POST",
                  model: candidate.model,
                  endpoint: route.endpoint,
                  userAgent: routeUa,
                  requestHeaders: upstreamRequestHeaders,
                  requestBody: forwardedBody,
                  status: "failed",
                  statusCode: 599,
                  durationMs: Date.now() - attemptStartedAt,
                  contentType,
                  responsePreview: responsePreview(JSON.stringify({ error: errorMessage })),
                  errorMessage
                });
                store.updateRequestLog(streamLog.id, {
                  ...requestLogBase,
                  routeId: route.id,
                  routeName: route.name,
                  endpoint: route.endpoint,
                  providerName: candidate.site.name,
                  providerId: candidate.site.id,
                  addressLabel: address.label,
                  model: candidate.model,
                  requestBody: body,
                  status: "failed",
                  statusCode: 599,
                  durationMs: Date.now() - startedAt,
                  requestHeaders: {
                    ...requestLogBase.requestHeaders,
                    ...upstreamAuthLog
                  },
                  upstreamUrl: target,
                  upstreamContentType: contentType,
                  responsePreview: responsePreview(JSON.stringify({ error: errorMessage })),
                  errorMessage,
                  downstream: downstreamLog,
                  routeTarget: routeTargetLog,
                  upstreamAttempts,
                  proxy: attemptProxy,
                  summary: chainSummary({
                    downstreamModel: downstreamLog.model,
                    downstreamEndpoint,
                    downstreamUa,
                    routeModel: candidate.model,
                    routeEndpoint: route.endpoint,
                    routeUa,
                    status: "failed"
                  })
                });
                response.end();
                return;
              }
            }

            const text = await upstream.text();
            if (looksLikeHtml(contentType, text)) {
              const errorMessage = "返回了 HTML 页面，请检查站点地址是否为 API Base URL";
              errors.push(`${address.label} ${target}：${upstream.status} ${errorMessage}`);
              upstreamAttempts.push({
                addressLabel: address.label,
                upstreamUrl: target,
                method: request.method || "POST",
                model: candidate.model,
                endpoint: route.endpoint,
                userAgent: routeUa,
                requestHeaders: upstreamRequestHeaders,
                requestBody: forwardedBody,
                status: "failed",
                statusCode: upstream.status,
                durationMs: Date.now() - attemptStartedAt,
                contentType,
                responsePreview: responsePreview(text),
                errorMessage
              });
              lastFailure = {
                address,
                target,
                statusCode: upstream.status,
                text,
                contentType
              };
              continue;
            }
            const adapted = convertUpstreamResponseText({
              text,
              contentType,
              proxyKind: proxyInfo.kind,
              converter: responseConverter,
              downstreamStream
            });
            upstreamAttempts.push({
              addressLabel: address.label,
              upstreamUrl: target,
              method: request.method || "POST",
              model: candidate.model,
              endpoint: route.endpoint,
              userAgent: routeUa,
              requestHeaders: upstreamRequestHeaders,
              requestBody: forwardedBody,
              status: "success",
              statusCode: upstream.status,
              durationMs: Date.now() - attemptStartedAt,
              contentType,
              responsePreview: responsePreview(adapted.text)
            });
            store.recordRequestLog({
              ...requestLogBase,
              routeId: route.id,
              routeName: route.name,
              endpoint: route.endpoint,
              providerName: candidate.site.name,
              providerId: candidate.site.id,
              addressLabel: address.label,
              model: candidate.model,
              requestBody: body,
              status: "success",
              statusCode: upstream.status,
              durationMs: Date.now() - startedAt,
              requestHeaders: {
                ...requestLogBase.requestHeaders,
                ...upstreamAuthLog
              },
              upstreamUrl: target,
              upstreamContentType: contentType,
              responsePreview: responsePreview(adapted.text),
              downstream: downstreamLog,
              routeTarget: routeTargetLog,
              upstreamAttempts,
              proxy: attemptProxy,
              summary: chainSummary({
                downstreamModel: downstreamLog.model,
                downstreamEndpoint,
                downstreamUa,
                routeModel: candidate.model,
                routeEndpoint: route.endpoint,
                routeUa,
                status: "success"
              })
            });
            markTemporaryAccountAttempt(candidate, upstream.status);
            markCandidateSuccess(route, candidate);
            response.writeHead(upstream.status, {
              "Content-Type": adapted.contentType || "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*"
            });
            response.end(adapted.text);
            return;
          }

          const text = await upstream.text();
          const htmlMessage = looksLikeHtml(contentType, text) ? "返回了 HTML 页面，请检查站点地址是否为 API Base URL" : "";
          const errorMessage = htmlMessage || extractUpstreamError(text) || `HTTP ${upstream.status}`;
          markTemporaryAccountAttempt(candidate, upstream.status, errorMessage);
          errors.push(`${address.label} ${target}：${upstream.status} ${errorMessage}`);
          upstreamAttempts.push({
            addressLabel: address.label,
            upstreamUrl: target,
            method: request.method || "POST",
            model: candidate.model,
            endpoint: route.endpoint,
            userAgent: routeUa,
            requestHeaders: upstreamRequestHeaders,
            requestBody: forwardedBody,
            status: "failed",
            statusCode: upstream.status,
            durationMs: Date.now() - attemptStartedAt,
            contentType,
            responsePreview: responsePreview(text),
            errorMessage
          });
          lastFailure = {
            address,
            target,
            statusCode: upstream.status,
            text,
            contentType
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "请求上游失败";
          markTemporaryAccountAttempt(candidate, 599, errorMessage);
          errors.push(`${address.label} ${target}：${errorMessage}`);
          upstreamAttempts.push({
            addressLabel: address.label,
            upstreamUrl: target,
            method: request.method || "POST",
            model: candidate.model,
            endpoint: route.endpoint,
            userAgent: routeUa,
            requestHeaders: upstreamRequestHeaders,
            requestBody: forwardedBody,
            status: "failed",
            statusCode: 599,
            durationMs: Date.now() - attemptStartedAt,
            contentType: "application/json; charset=utf-8",
            responsePreview: responsePreview(JSON.stringify({ error: errorMessage })),
            errorMessage
          });
          lastFailure = {
            address,
            target,
            statusCode: 502,
            text: JSON.stringify({ error: errorMessage }),
            contentType: "application/json; charset=utf-8"
          };
        }
      }
    }
    }

    const message = `上游地址均不可用：${errors.join("；") || "没有可用地址"}`;
    const failedCandidate = lastAttemptContext?.candidate || candidates[0];
    const failedAddress = lastFailure?.address || failedCandidate?.addresses[0];
    const failedRouteUa = lastAttemptContext?.routeUa || "fetch default";
    const failedRouteTargetLog =
      lastAttemptContext?.routeTargetLog || {
        routeName: route.name,
        model: failedCandidate?.model || (route.type === "group" ? route.name : route.model),
        endpoint: route.endpoint,
        providerName: failedCandidate?.site.name || (route.type === "group" ? "分组路由" : "未匹配"),
        userAgent: failedRouteUa
      };
    store.recordRequestLog({
      ...requestLogBase,
      routeId: route.id,
      routeName: route.name,
      endpoint: route.endpoint,
      providerName: failedCandidate?.site.name || "未匹配",
      providerId: failedCandidate?.site.id,
      addressLabel: failedAddress?.label,
      model: failedCandidate?.model || (route.type === "group" ? route.name : route.model),
      requestBody: body,
      status: "failed",
      statusCode: lastFailure?.statusCode || 502,
      durationMs: Date.now() - startedAt,
      requestHeaders: {
        ...requestLogBase.requestHeaders,
        ...(lastAttemptContext?.upstreamAuthLog || {})
      },
      upstreamUrl: lastFailure?.target,
      upstreamContentType: lastFailure?.contentType,
      responsePreview: lastFailure?.text ? responsePreview(lastFailure.text) : undefined,
      errorMessage: message,
      downstream: downstreamLog,
      routeTarget: failedRouteTargetLog,
      upstreamAttempts,
      proxy: requestLogProxyForRoute(route.proxy),
      summary: chainSummary({
        downstreamModel: downstreamLog.model,
        downstreamEndpoint,
        downstreamUa,
        routeModel: failedRouteTargetLog.model,
        routeEndpoint: route.endpoint,
        routeUa: failedRouteUa,
        status: "failed"
      })
    });
    if (lastFailure?.text) {
      response.writeHead(lastFailure.statusCode, {
        "Content-Type": lastFailure.contentType || "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      });
      response.end(lastFailure.text);
      return;
    }
    sendJson(response, 502, { error: message });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proxy failed";
    store.recordRequestLog({
      ...requestLogBase,
      ...routeLogContext,
      requestBody: body,
      status: "failed",
      statusCode: 502,
      durationMs: Date.now() - startedAt,
      errorMessage: message
    });
    sendJson(response, 502, { error: message });
  }
}

async function handleUnsupportedProxyPath(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const startedAt = Date.now();
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    body = undefined;
  }
  const routeName = requestModelName(body);
  store.recordRequestLog({
    routeName: routeName || "unknown",
    method: request.method || "POST",
    path: url.pathname,
    providerName: "未匹配",
    model: routeName || "未匹配",
    userAgent: valueToHeaderText(request.headers["user-agent"]),
    clientIp: request.socket.remoteAddress || "",
    requestHeaders: maskRequestHeaders(request.headers),
    requestBody: body,
    status: "failed",
    statusCode: 404,
    durationMs: Date.now() - startedAt,
    errorMessage: unsupportedProxyMessage()
  });
  sendJson(response, 404, { error: unsupportedProxyMessage() });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "OPTIONS") {
    sendCorsPreflight(request, response);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }
  if (isSupportedProxyPath(url.pathname)) {
    await handleProxy(request, response, url);
    return;
  }
  if (url.pathname.startsWith("/proxy/")) {
    await handleUnsupportedProxyPath(request, response, url);
    return;
  }
  if (handleStatic(request, response, url)) return;
  notFound(response);
});

server.listen(PORT, HOST, () => {
  console.log(`SamAPI API is running at http://${HOST}:${PORT}`);
  console.log(`Local access: http://127.0.0.1:${PORT}`);
  console.log(`Database: ${store.dbPath}`);
  console.log(`Web UI: ${WEB_DIR}`);
  console.log("Fetch proxy: per-route");
  if (ADMIN_PASSWORD_IS_DEFAULT && !store.getAdminPasswordHash()) {
    console.warn("Admin password is using the local default: samapi-admin. Set SAMAPI_ADMIN_PASSWORD before exposing SamAPI publicly.");
  }
});
