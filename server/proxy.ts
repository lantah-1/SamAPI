import { execFileSync } from "node:child_process";
import { URL } from "node:url";
import { ProxyAgent } from "undici";
import type { RequestLogProxy, RouteProxyConfig } from "../shared/types.js";

export interface ResolvedProxy {
  mode: RequestLogProxy["mode"];
  url?: string;
  source?: RequestLogProxy["source"];
}

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

const proxyAgents = new Map<string, ProxyAgent>();
let systemProxyCache: { checkedAt: number; proxy?: ResolvedProxy } = { checkedAt: 0 };
const SYSTEM_PROXY_CACHE_TTL_MS = 10_000;

export function resolveSystemProxy(force = false): ResolvedProxy {
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

export function routeProxy(routeProxy?: RouteProxyConfig, forceSystemRefresh = false): ResolvedProxy {
  if (!routeProxy || routeProxy.mode === "direct") return { mode: "direct" };
  if (routeProxy.mode === "custom") return { mode: "custom", url: routeProxy.url, source: "route" };
  return resolveSystemProxy(forceSystemRefresh);
}

function maskedProxyUrlValue(proxyUrl?: string) {
  return proxyUrl ? maskedProxyUrl(proxyUrl) : undefined;
}

export function requestLogProxyForRoute(routeProxyConfig?: RouteProxyConfig, forceSystemRefresh = false): RequestLogProxy {
  const resolvedProxy = routeProxy(routeProxyConfig, forceSystemRefresh);
  return { ...resolvedProxy, url: maskedProxyUrlValue(resolvedProxy.url) };
}

// Guardrails against connection-pool exhaustion: cap concurrent connections to the proxy,
// fail fast if the proxy itself is unreachable, and allow arbitrarily long streaming bodies.
const PROXY_AGENT_CONNECTIONS = 128;
const PROXY_AGENT_CONNECT_TIMEOUT_MS = 15_000;
const PROXY_AGENT_HEADERS_TIMEOUT_MS = 60_000;

export function proxyAgentFor(proxyUrl: string) {
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const agent = new ProxyAgent({
    uri: proxyUrl,
    connections: PROXY_AGENT_CONNECTIONS,
    connectTimeout: PROXY_AGENT_CONNECT_TIMEOUT_MS,
    headersTimeout: PROXY_AGENT_HEADERS_TIMEOUT_MS,
    bodyTimeout: 0
  });
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

export function clearProxyAgent(proxyUrl?: string) {
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

export async function fetchWithRouteProxy(target: Parameters<typeof fetch>[0], init: RequestInit, routeProxyConfig?: RouteProxyConfig) {
  let resolvedProxy = routeProxy(routeProxyConfig);
  const proxyInit = resolvedProxy.url ? { ...init, dispatcher: proxyAgentFor(resolvedProxy.url) } as RequestInit & { dispatcher: ProxyAgent } : init;
  try {
    const response = await fetch(target, proxyInit);
    return { response, proxy: { ...resolvedProxy, url: maskedProxyUrlValue(resolvedProxy.url) } satisfies RequestLogProxy };
  } catch (error) {
    // Do not retry aborted requests — the caller (usually the client disconnect handler) meant to cancel.
    if ((error as { name?: string } | undefined)?.name === "AbortError") throw error;
    if (!routeProxyConfig || routeProxyConfig.mode === "direct" || !isNetworkError(error)) throw error;
    clearProxyAgent(resolvedProxy.url);
    resolvedProxy = routeProxy(routeProxyConfig, true);
    const retryInit = resolvedProxy.url ? { ...init, dispatcher: proxyAgentFor(resolvedProxy.url) } as RequestInit & { dispatcher: ProxyAgent } : init;
    const response = await fetch(target, retryInit);
    return { response, proxy: { ...resolvedProxy, url: maskedProxyUrlValue(resolvedProxy.url), retried: true } satisfies RequestLogProxy };
  }
}

export function maskedProxyUrl(proxyUrl: string) {
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

export function errorText(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

export function errorCode(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const code = "code" in value ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

function errorDetailValue(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value)) return "";
  const detail = (value as Record<string, unknown>)[key];
  return typeof detail === "string" || typeof detail === "number" ? String(detail) : "";
}

function nestedErrorCause(error: unknown) {
  if (!error || typeof error !== "object" || !("cause" in error)) return undefined;
  return (error as { cause?: unknown }).cause;
}

function networkErrorReason(code: string) {
  const normalized = code.toUpperCase();
  if (normalized === "ECONNREFUSED") return "代理或上游拒绝连接";
  if (normalized === "ENOTFOUND") return "域名解析失败";
  if (normalized === "ETIMEDOUT" || normalized === "UND_ERR_CONNECT_TIMEOUT") return "连接超时";
  if (normalized === "ECONNRESET") return "连接被重置";
  if (normalized === "CERT_HAS_EXPIRED" || normalized.includes("CERT")) return "TLS 证书校验失败";
  return code || "";
}

export function upstreamNetworkErrorMessage(error: unknown, fallback: string) {
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
  const details = [
    reason,
    host ? `host=${host}` : "",
    port ? `port=${port}` : "",
    address ? `address=${address}` : "",
    code ? `code=${code}` : "",
    causeMessage && causeMessage !== message ? causeMessage : ""
  ].filter(Boolean);
  const currentProxy = resolveSystemProxy();
  const proxyHint = currentProxy.url
    ? `当前系统代理 ${maskedProxyUrl(currentProxy.url)}，请确认代理可访问 OpenAI/Codex`
    : "当前没有检测到系统代理，可在路由或账号检查里选择系统/自定义代理";
  return `${fallback}${details.length > 0 ? `：${details.join("，")}` : `：${message}`}。${proxyHint}`;
}
