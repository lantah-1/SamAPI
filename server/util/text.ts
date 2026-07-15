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
