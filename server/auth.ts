import http from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { ADMIN_COOKIE_SECURE, ADMIN_PASSWORD, ADMIN_SESSION_COOKIE } from "./config.js";
import { sendJson } from "./http.js";
import type { JsonStore } from "./store.js";

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

export function createAuth(store: JsonStore) {
  function verifyAdminPassword(password: string) {
    const savedHash = store.getAdminPasswordHash();
    return savedHash ? safeEqualPasswordHash(password, savedHash) : safeEqualText(password, ADMIN_PASSWORD);
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

  function adminSessionCookie(token: string) {
    const maxAge = Math.max(0, Math.floor(adminSessionTtlMs() / 1000));
    return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${ADMIN_COOKIE_SECURE ? "; Secure" : ""}`;
  }

  function renewAdminSession(response: http.ServerResponse) {
    const session = createAdminSession();
    response.setHeader("Set-Cookie", adminSessionCookie(session.token));
    return session;
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

  return {
    adminSessionCookie,
    clearAdminSessionCookie,
    createAdminSession,
    hasAdminSession,
    renewAdminSession,
    requireAdminSession,
    verifyAdminPassword
  };
}
