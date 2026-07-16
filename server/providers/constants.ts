import type { ProxyAgent } from "undici";
import { proxyAgentFor, routeProxy } from "../proxy.js";
import { positiveIntegerEnv } from "../util/text.js";
import type { RouteProxyConfig } from "../../shared/types.js";

export const CODEX_BACKEND_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_USER_AGENT = "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)";
export const CODEX_ORIGINATOR = "codex-tui";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_DEFAULT_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_CLI_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const CHATGPT_MODELS_URL = "https://chatgpt.com/backend-api/models";
export const CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL = "ChatGPT 官方";
export const TEMPORARY_ACCOUNT_CHECK_TIMEOUT_MS = positiveIntegerEnv("SAMAPI_TEMPORARY_ACCOUNT_CHECK_TIMEOUT_MS", 15_000);
export const TEMPORARY_ACCOUNT_CHECK_CONCURRENCY = positiveIntegerEnv("SAMAPI_TEMPORARY_ACCOUNT_CHECK_CONCURRENCY", 6);

export async function fetchTemporaryAccountCheckText(input: Parameters<typeof fetch>[0], init: RequestInit = {}, proxyConfig: RouteProxyConfig = { mode: "system" }) {
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

