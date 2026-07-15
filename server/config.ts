import path from "node:path";

export const PORT = Number(process.env.SAMAPI_PORT || process.env.PORT || 8787);
export const HOST = process.env.SAMAPI_HOST || "0.0.0.0";
export const WEB_DIR = path.resolve(process.env.SAMAPI_WEB_DIR || path.join(process.cwd(), "dist"));

export const ADMIN_PASSWORD = process.env.SAMAPI_ADMIN_PASSWORD || "samapi-admin";
export const ADMIN_PASSWORD_IS_DEFAULT = !process.env.SAMAPI_ADMIN_PASSWORD;
export const ADMIN_SESSION_COOKIE = "samapi_admin";
export const ADMIN_COOKIE_SECURE = process.env.SAMAPI_ADMIN_COOKIE_SECURE === "true";

export const DEFAULT_CORS_HEADERS = [
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
