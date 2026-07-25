import http from "node:http";
import { URL } from "node:url";
import { valueToHeaderText } from "../http.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function bodyRecord(body: unknown) {
  return isRecord(body) ? body : {};
}

export function textFromContent(value: unknown): string {
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

export function maskRequestHeaders(headers: http.IncomingHttpHeaders) {
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

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function forwardableRequestHeaders(headers: http.IncomingHttpHeaders) {
  const forwarded: Record<string, string> = {};
  const connectionHeaders = new Set(
    valueToHeaderText(headers.connection)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(normalizedKey) || connectionHeaders.has(normalizedKey)) continue;
    const text = valueToHeaderText(value);
    if (text) forwarded[key] = text;
  }
  return forwarded;
}

export function maskedStringHeaders(headers: Record<string, string>) {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = ["authorization", "x-api-key", "cookie"].includes(key.toLowerCase()) ? "***" : value;
  }
  return masked;
}

export function responsePreview(text: string) {
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

export function compactPreview(text: string) {
  return responsePreview(text.replace(/\s+/g, " ").trim());
}

export function requestApiKey(request: http.IncomingMessage, url: URL) {
  const apiKey = request.headers.authorization || request.headers["x-api-key"] || url.searchParams.get("key") || undefined;
  return Array.isArray(apiKey) ? apiKey[0] : apiKey;
}

export function normalizeClientIp(value?: string) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  if (trimmed.toLowerCase().startsWith("::ffff:")) return trimmed.slice(7);
  return trimmed;
}

export function isLoopbackIp(value?: string) {
  const ip = normalizeClientIp(value).toLowerCase();
  return !ip || ip === "127.0.0.1" || ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip === "localhost";
}

function firstForwardedIp(value?: string) {
  const raw = (value || "").trim();
  if (!raw) return "";
  return raw.split(",")[0]?.trim() || "";
}

export function clientIpFromHeaders(
  headers: http.IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  fallback = ""
) {
  const candidates = [
    valueToHeaderText(headers["cf-connecting-ip"]),
    valueToHeaderText(headers["true-client-ip"]),
    firstForwardedIp(valueToHeaderText(headers["x-forwarded-for"])),
    valueToHeaderText(headers["x-real-ip"]),
    fallback
  ];
  for (const candidate of candidates) {
    const normalized = normalizeClientIp(candidate);
    if (normalized) return normalized;
  }
  return "";
}

export function requestClientIp(request: http.IncomingMessage) {
  return clientIpFromHeaders(request.headers, request.socket.remoteAddress || "");
}

export function clientDeviceFromUserAgent(userAgent?: string) {
  const ua = (userAgent || "").trim();
  if (!ua) return "Unknown client";

  let client = userAgentClientKind(ua) || "HTTP client";
  if (client === "HTTP client") {
    const firstToken = ua.split(/[\s/]/)[0];
    if (firstToken) client = firstToken;
  }

  let platform = "";
  if (/iPhone/i.test(ua)) platform = "iPhone / iOS";
  else if (/iPad/i.test(ua)) platform = "iPad / iPadOS";
  else if (/Android/i.test(ua)) platform = "Android";
  else if (/Windows NT/i.test(ua)) platform = "Windows";
  else if (/Mac OS X|Mac OS/i.test(ua)) {
    const version = ua.match(/Mac OS(?: X)?[ /;]*([0-9]+(?:[._][0-9]+){0,2})/i)?.[1]?.replaceAll("_", ".");
    platform = version ? `macOS ${version}` : "macOS";
  } else if (/Linux/i.test(ua)) platform = "Linux";

  let architecture = "";
  if (/arm64|aarch64|AppleWebKit.*(Mac OS|Macintosh)/i.test(ua) && /arm64|aarch64/i.test(ua)) architecture = "ARM64";
  else if (/x86_64|amd64|win64|x64/i.test(ua)) architecture = "x64";

  return [client, platform, architecture].filter(Boolean).join(" / ");
}

export function userAgentClientKind(userAgent?: string) {
  const ua = (userAgent || "").trim();
  if (!ua) return undefined;
  if (/codex desktop/i.test(ua)) return "Codex Desktop";
  if (/codex[-_ ](?:tui|cli(?:_rs)?)/i.test(ua)) return "Codex CLI";
  if (/claude(?:[-_ ]cli)?\//i.test(ua)) return "Claude CLI";
  if (/curl\//i.test(ua)) return "curl";
  if (/python-requests|python\//i.test(ua)) return "Python client";
  if (/postmanruntime/i.test(ua)) return "Postman";
  if (/mozilla\//i.test(ua)) {
    if (/edg\//i.test(ua)) return "Edge";
    if (/chrome\//i.test(ua)) return "Chrome";
    if (/firefox\//i.test(ua)) return "Firefox";
    if (/safari\//i.test(ua)) return "Safari";
    return "Browser";
  }
  return undefined;
}

export function userAgentsHaveSameClient(downstreamUserAgent?: string, templateUserAgent?: string) {
  const downstreamClient = userAgentClientKind(downstreamUserAgent);
  return Boolean(downstreamClient && downstreamClient === userAgentClientKind(templateUserAgent));
}

export function resolveStoredClientIp(log: { clientIp?: string; requestHeaders?: Record<string, string> }) {
  const stored = normalizeClientIp(log.clientIp);
  if (stored && !isLoopbackIp(stored)) return stored;
  return clientIpFromHeaders(log.requestHeaders || {}, stored || log.clientIp || "");
}

export function maskSecret(secret: string) {
  const trimmed = secret.trim();
  return trimmed ? `${trimmed.slice(0, 10)}...` : "";
}

export function extractUpstreamError(text: string) {
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

function displayableUpstreamUrl(value: string) {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

export function appendUpstreamUrlToErrorResponse(text: string, contentType: string | undefined, upstreamUrl: string) {
  const safeUrl = displayableUpstreamUrl(upstreamUrl);
  const suffix = `上游 URL: ${safeUrl}`;
  const appendMessage = (message: string) => message.includes(safeUrl) ? message : `${message}（${suffix}）`;
  const trimmed = text.trim();
  const looksJson = contentType?.toLowerCase().includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");

  if (looksJson) {
    try {
      const payload = JSON.parse(trimmed) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>;
        if (typeof record.error === "string") {
          return JSON.stringify({ ...record, error: appendMessage(record.error), upstream_url: safeUrl });
        }
        if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
          const error = record.error as Record<string, unknown>;
          if (typeof error.message === "string") {
            return JSON.stringify({ ...record, error: { ...error, message: appendMessage(error.message) }, upstream_url: safeUrl });
          }
        }
        if (typeof record.message === "string") {
          return JSON.stringify({ ...record, message: appendMessage(record.message), upstream_url: safeUrl });
        }
        return JSON.stringify({ ...record, upstream_url: safeUrl });
      }
    } catch {
      // Fall through to the plain-text response below.
    }
  }

  return text ? `${text}${text.endsWith("\n") ? "" : "\n"}${suffix}` : JSON.stringify({ error: suffix, upstream_url: safeUrl });
}

export function looksLikeHtmlText(text: string) {
  const compact = text.trim().slice(0, 120).toLowerCase();
  return compact.startsWith("<!doctype") || compact.startsWith("<html") || compact.includes("<head") || compact.includes("<body");
}

export function looksLikeHtml(contentType: string | undefined, text: string) {
  const compact = text.trim().slice(0, 80).toLowerCase();
  return Boolean(contentType?.toLowerCase().includes("text/html") || compact.startsWith("<!doctype") || compact.startsWith("<html"));
}

export function joinUrl(baseUrl: string, suffix: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

export function v1BaseUrl(baseUrl: string) {
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

export function requestModelName(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const model = (body as { model?: unknown }).model;
  return typeof model === "string" ? model.trim() : "";
}

export function headerKey(headers: Record<string, string>, name: string) {
  return Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
}

export function headerValue(headers: Record<string, string>, name: string) {
  const key = headerKey(headers, name);
  return key ? headers[key].trim() : "";
}

export function setHeader(headers: Record<string, string>, name: string, value: string) {
  const existingKey = headerKey(headers, name);
  headers[existingKey || name] = value;
}

export function deleteHeader(headers: Record<string, string>, name: string) {
  const existingKey = headerKey(headers, name);
  if (existingKey) delete headers[existingKey];
}

export function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
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

export function jwtPayload(token?: string) {
  const parts = token?.split(".") || [];
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function codexAccountIdFromIdToken(idToken?: string) {
  const payload = jwtPayload(idToken);
  const auth = isRecord(payload?.["https://api.openai.com/auth"]) ? payload?.["https://api.openai.com/auth"] : undefined;
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

export function emailFromIdToken(idToken?: string) {
  const email = jwtPayload(idToken)?.email;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}
