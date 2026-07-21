import { createHash, randomBytes, randomUUID } from "node:crypto";
import { emailFromIdToken, extractUpstreamError, isRecord, textFromContent } from "../util/text.js";
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

const GROK_SUPPORTED_INPUT_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "reasoning",
  "item_reference"
]);

const GROK_REASONING_EFFORTS = new Set(["low", "medium", "high"]);

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

function defaultFunctionParameters() {
  return { type: "object", properties: {} };
}

function grokFunctionToolFromUnknown(tool: unknown, namePrefix = ""): Record<string, unknown> | undefined {
  if (!isRecord(tool)) return undefined;
  const rawName = typeof tool.name === "string" ? tool.name.trim() : "";
  if (!rawName) return undefined;
  const name = namePrefix ? `${namePrefix}${rawName}` : rawName;
  const description = typeof tool.description === "string" ? tool.description : "";
  const parameters = isRecord(tool.parameters)
    ? tool.parameters
    : isRecord(tool.input_schema)
      ? tool.input_schema
      : defaultFunctionParameters();
  const converted: Record<string, unknown> = {
    type: "function",
    name,
    description,
    parameters
  };
  if (typeof tool.strict === "boolean") converted.strict = tool.strict;
  return converted;
}

function grokToolsFromUnknown(tools: unknown, namePrefix = ""): Record<string, unknown>[] {
  if (!Array.isArray(tools)) return [];
  const converted: Record<string, unknown>[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const type = typeof tool.type === "string" ? tool.type : "function";
    if (type === "namespace") {
      const namespace = typeof tool.name === "string" ? tool.name.trim() : "";
      converted.push(...grokToolsFromUnknown(tool.tools, namespace ? `${namespace}__` : namePrefix));
      continue;
    }
    if (type === "custom") {
      // Codex custom/grammar tools are not Grok ModelInput tools; expose a plain function shell.
      const custom = grokFunctionToolFromUnknown({
        ...tool,
        parameters: isRecord(tool.parameters) ? tool.parameters : {
          type: "object",
          properties: {
            input: { type: "string", description: "Tool input" }
          },
          required: ["input"],
          additionalProperties: false
        }
      }, namePrefix);
      if (custom) converted.push(custom);
      continue;
    }
    if (type === "function" || !tool.type) {
      const fn = grokFunctionToolFromUnknown(tool, namePrefix);
      if (fn) converted.push(fn);
    }
  }
  return converted;
}

function grokMessageRole(role: unknown) {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function grokMessageContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromContent(content);
  const parts = content
    .map((part) => {
      if (typeof part === "string") return { type: "input_text", text: part };
      if (!isRecord(part)) return undefined;
      const type = typeof part.type === "string" ? part.type : "";
      if (type === "input_text" || type === "output_text" || type === "text") {
        const text = typeof part.text === "string" ? part.text : textFromContent(part);
        if (!text) return undefined;
        return {
          type: type === "output_text" ? "output_text" : "input_text",
          text
        };
      }
      if (type === "input_image" || type === "image_url") return part;
      const text = textFromContent(part);
      return text ? { type: "input_text", text } : undefined;
    })
    .filter((part): part is Record<string, unknown> => Boolean(part));
  return parts.length > 0 ? parts : "";
}

function grokInputItemFromUnknown(item: unknown): Record<string, unknown> | string | undefined {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return undefined;

  const type = typeof item.type === "string" ? item.type : "message";
  if (type === "additional_tools") return undefined;
  if (!GROK_SUPPORTED_INPUT_TYPES.has(type) && type !== "message") return undefined;

  if (type === "function_call") {
    if (typeof item.name !== "string" || typeof item.call_id !== "string") return undefined;
    return {
      type,
      call_id: item.call_id,
      name: item.name,
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
    };
  }

  if (type === "function_call_output") {
    if (typeof item.call_id !== "string") return undefined;
    return {
      type,
      call_id: item.call_id,
      output: typeof item.output === "string" ? item.output : textFromContent(item.output) || JSON.stringify(item.output ?? "")
    };
  }

  if (type === "reasoning" || type === "item_reference") {
    const cloned: Record<string, unknown> = { ...item, type };
    delete cloned.id;
    return cloned;
  }

  const role = grokMessageRole(item.role);
  const content = grokMessageContent(item.content);
  if (content === "" || (Array.isArray(content) && content.length === 0)) return undefined;
  return {
    type: "message",
    role,
    content
  };
}

function grokReasoningFromUnknown(value: unknown) {
  if (!isRecord(value)) return undefined;
  const effortRaw = typeof value.effort === "string" ? value.effort.toLowerCase() : "";
  const effort =
    effortRaw === "xhigh" || effortRaw === "maximal" || effortRaw === "max"
      ? "high"
      : GROK_REASONING_EFFORTS.has(effortRaw)
        ? effortRaw
        : undefined;
  return effort ? { effort } : undefined;
}

export function grokOAuthRequestBody(body: unknown, model: string) {
  const source: Record<string, unknown> = isRecord(body) ? { ...body } : { input: body };
  const extractedTools: Record<string, unknown>[] = [];
  const inputSource = source.input;

  if (Array.isArray(inputSource)) {
    for (const item of inputSource) {
      if (isRecord(item) && item.type === "additional_tools") {
        extractedTools.push(...grokToolsFromUnknown(item.tools));
      }
    }
    const input = inputSource
      .map((item) => grokInputItemFromUnknown(item))
      .filter((item): item is Record<string, unknown> | string => item !== undefined);
    source.input = input.length > 0 ? input : "hi";
  } else if (inputSource != null && typeof inputSource !== "string") {
    source.input = textFromContent(inputSource) || "hi";
  }

  extractedTools.push(...grokToolsFromUnknown(source.tools));
  if (extractedTools.length > 0) {
    const seen = new Set<string>();
    source.tools = extractedTools.filter((tool) => {
      const name = typeof tool.name === "string" ? tool.name : "";
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  } else {
    delete source.tools;
  }

  const reasoning = grokReasoningFromUnknown(source.reasoning);
  if (reasoning) source.reasoning = reasoning;
  else delete source.reasoning;

  if (source.tool_choice != null && source.tool_choice !== "auto" && source.tool_choice !== "none" && source.tool_choice !== "required" && !isRecord(source.tool_choice)) {
    delete source.tool_choice;
  }

  source.model = model;
  if (typeof source.stream !== "boolean") source.stream = true;

  delete source.metadata;
  delete source.client_metadata;
  delete source.include;
  delete source.text;
  delete source.prompt_cache_key;
  delete source.prompt_cache_retention;
  delete source.parallel_tool_calls;
  delete source.store;
  delete source.previous_response_id;
  delete source.safety_identifier;
  delete source.stream_options;
  delete source.max_output_tokens;

  return source;
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
