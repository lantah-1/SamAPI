import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";
import type { JsonStore } from "./store.js";
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_TOKEN_URL, fetchTemporaryAccountCheckText } from "./providers/constants.js";
import { codexAccountIdFromIdToken, emailFromIdToken, jwtPayload } from "./util/text.js";

const AUTHORIZATION_URL = "https://auth.openai.com/oauth/authorize";
const configuredCallbackPort = Number(process.env.SAMAPI_CODEX_OAUTH_CALLBACK_PORT || process.env.SAMAPI_OAUTH_CALLBACK_PORT || 1455);
const CALLBACK_PORT = Number.isInteger(configuredCallbackPort) && configuredCallbackPort > 0 && configuredCallbackPort <= 65535
  ? configuredCallbackPort
  : 1455;
const CALLBACK_PATH = "/auth/callback";
const SESSION_TTL_MS = 10 * 60 * 1000;

type OAuthSession = {
  state: string;
  verifier: string;
  redirectUri: string;
  status: "pending" | "success" | "error";
  error?: string;
  accountId?: string;
  createdAt: number;
};

function base64Url(value: Buffer) { return value.toString("base64url"); }
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}
function html(message: string) { return `<!doctype html><meta charset="utf-8"><title>SamAPI OAuth</title><p>${escapeHtml(message)}</p>`; }

export function createCodexOAuth(store: JsonStore) {
  const sessions = new Map<string, OAuthSession>();
  let callbackServer: http.Server | undefined;
  let callbackPromise: Promise<void> | undefined;

  function cleanup() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [state, session] of sessions) if (session.createdAt < cutoff) sessions.delete(state);
  }

  async function ensureCallbackServer() {
    if (callbackPromise) return callbackPromise;
    callbackPromise = new Promise<void>((resolve, reject) => {
      callbackServer = http.createServer((request, response) => {
        void handleCallback(request, response).catch((error) => {
          response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          response.end(html(`OAuth 回调失败：${error instanceof Error ? error.message : String(error)}`));
        });
      });
      callbackServer.once("error", reject);
      callbackServer.listen(CALLBACK_PORT, "127.0.0.1", () => {
        callbackServer?.removeListener("error", reject);
        resolve();
      });
    }).catch((error) => {
      callbackPromise = undefined;
      callbackServer = undefined;
      throw new Error(`无法监听 OAuth 回调端口 ${CALLBACK_PORT}：${error instanceof Error ? error.message : String(error)}`);
    });
    return callbackPromise;
  }

  async function exchangeCode(session: OAuthSession, code: string) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH_CLIENT_ID,
      code,
      redirect_uri: session.redirectUri,
      code_verifier: session.verifier
    });
    const { response, text } = await fetchTemporaryAccountCheckText(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    let payload: Record<string, unknown> = {};
    try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* handled below */ }
    if (!response.ok) throw new Error(`Token exchange failed (HTTP ${response.status})${payload.error_description || payload.error ? `: ${payload.error_description || payload.error}` : ""}`);
    const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
    const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : "";
    const idToken = typeof payload.id_token === "string" ? payload.id_token.trim() : "";
    if (!accessToken || !refreshToken) throw new Error("Token exchange response is missing access_token or refresh_token");
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
    const accountId = codexAccountIdFromIdToken(idToken) || (typeof jwtPayload(idToken)?.sub === "string" ? jwtPayload(idToken)?.sub as string : undefined);
    const email = emailFromIdToken(idToken);
    return store.saveCodexOAuthAccount({ accessToken, refreshToken, idToken, accountId, email, tokenExpiresAt }).account.id;
  }

  async function handleCallback(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (url.pathname !== CALLBACK_PATH) { response.writeHead(404); response.end("Not found"); return; }
    cleanup();
    const state = url.searchParams.get("state") || "";
    const session = sessions.get(state);
    if (!session) { response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }); response.end(html("OAuth state 无效或已过期。")); return; }
    if (session.status !== "pending") { response.writeHead(409, { "Content-Type": "text/html; charset=utf-8" }); response.end(html("OAuth 回调已经处理，请返回 SamAPI。")); return; }
    const error = url.searchParams.get("error");
    if (error) {
      session.status = "error"; session.error = url.searchParams.get("error_description") || error;
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }); response.end(html("OAuth 授权失败，可以关闭此页面。")); return;
    }
    const code = url.searchParams.get("code") || "";
    if (!code) { session.status = "error"; session.error = "Missing authorization code"; response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }); response.end(html("缺少授权码。")); return; }
    try {
      session.accountId = await exchangeCode(session, code);
      session.status = "success";
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html("OAuth 授权成功，可以关闭此页面并返回 SamAPI。"));
    } catch (caught) {
      session.status = "error";
      session.error = caught instanceof Error ? caught.message : String(caught);
      console.error(`[codex-oauth] callback failed: ${session.error}`);
      response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html(`OAuth token 写入失败：${session.error}。可以返回 SamAPI 后重试。`));
    }
  }

  async function start() {
    cleanup();
    await ensureCallbackServer();
    const state = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
    sessions.set(state, { state, verifier, redirectUri, status: "pending", createdAt: Date.now() });
    const authorizationUrl = new URL(AUTHORIZATION_URL);
    authorizationUrl.search = new URLSearchParams({
      client_id: CODEX_OAUTH_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid email profile offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true"
    }).toString();
    return { state, authorizationUrl: authorizationUrl.toString(), redirectUri };
  }

  function status(state: string) {
    cleanup();
    const session = sessions.get(state);
    if (!session) return undefined;
    return { state, status: session.status, error: session.error, accountId: session.accountId };
  }

  return { start, status, close: () => callbackServer?.close() };
}
