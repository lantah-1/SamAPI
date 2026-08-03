import http from "node:http";
import { URL } from "node:url";
import type { JsonStore } from "../store.js";
import {
  clientDeviceFromUserAgent,
  appendUpstreamUrlToErrorResponse,
  deleteHeader,
  extractUpstreamError,
  forwardableRequestHeaders,
  headerValue,
  looksLikeHtml,
  maskedStringHeaders,
  maskRequestHeaders,
  maskSecret,
  requestApiKey,
  requestClientIp,
  requestModelName,
  responsePreview,
  setHeader,
  userAgentsHaveSameClient
} from "../util/text.js";
import { readJson, sendJson, valueToHeaderText } from "../http.js";
import { proxyEndpointCandidates } from "../util/endpoints.js";
import {
  proxyKindLabel,
  proxyPathInfo,
  proxyRouteName,
  unsupportedProxyMessage,
  wantsAnthropicModelsFormat
} from "../proxy-path.js";
import type { ProxyKind, RosettaConverter, RouteEndpointKind } from "../proxy-path.js";
import {
  convertedRouteRequestBody,
  isStreamingRequest,
  applyStreamingFlag,
  sanitizeOpenAiCompatibleResponsesBody
} from "../convert/payload.js";
import {
  convertUpstreamResponseText,
  streamConvertedResponse,
  streamRawResponse,
  streamResponseContentType
} from "../convert/stream.js";
import { fetchWithRouteProxy, requestLogProxyForRoute } from "../proxy.js";
import { parseHeaderTemplate } from "../store.js";
import { CODEX_BACKEND_RESPONSES_URL, CODEX_USER_AGENT } from "../providers/constants.js";
import { codexTemporaryHeaders, codexTemporaryRequestBody, collectCodexResponsesBody } from "../providers/codex.js";
import {
  agentIdentityAuthorization,
  ensureOpenAiAgentIdentityTask,
  isOpenAiAgentIdentityAccount,
  isOpenAiAgentIdentityTaskInvalid,
  redactOpenAiAgentIdentityText
} from "../providers/openai-agent-identity.js";
import {
  grokOAuthAccessTokenNeedsRefresh,
  createGrokResponsesToolConverter,
  grokCustomToolNames,
  grokOAuthBaseUrl,
  grokOAuthHeaders,
  grokOAuthRequestBody,
  isGrokEncryptedContentError,
  isGrokOAuthTemporaryAccount,
  refreshGrokOAuthTemporaryAccountToken,
  stripGrokEncryptedReasoning
} from "../providers/grok.js";
import type { ProxyExecutionCandidate } from "../routing.js";
import type { RequestLog, RequestLogStatus, RequestLogUpstreamRequest, RouteRecord, SiteAddress } from "../../shared/types.js";

function chainSummary(input: {
  downstreamModel?: string;
  downstreamEndpoint?: string;
  downstreamUa?: string;
  routeModel?: string;
  routeEndpoint?: string;
  routeUa?: string;
  status: RequestLogStatus;
}) {
  const statusLabel = input.status === "success"
    ? "成功"
    : input.status === "pending"
      ? "请求中"
      : input.status === "cancelled"
        ? "已取消"
        : "失败";
  return `下游 ${input.downstreamModel || "unknown"} (${input.downstreamEndpoint || "unknown"} / ${input.downstreamUa || "unknown ua"}) -> 路由目标 ${input.routeModel || "unknown"} (${input.routeEndpoint || "unknown"} / ${input.routeUa || "unknown ua"}) -> ${statusLabel}`;
}

function isClientAbortError(signal: AbortSignal, error: unknown) {
  if (signal.aborted || (error as { name?: string } | undefined)?.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return /客户端已断开连接|\b(?:this|the) operation was aborted\b/i.test(message);
}

const UPSTREAM_429_RETRY_COUNT = 5;

async function fetchWith429Retry(
  target: Parameters<typeof fetchWithRouteProxy>[0],
  init: Parameters<typeof fetchWithRouteProxy>[1],
  routeProxyConfig: Parameters<typeof fetchWithRouteProxy>[2],
  timeoutMs: Parameters<typeof fetchWithRouteProxy>[3]
) {
  let result = await fetchWithRouteProxy(target, init, routeProxyConfig, timeoutMs);
  for (let retry = 0; retry < UPSTREAM_429_RETRY_COUNT && result.response.status === 429; retry += 1) {
    result.response.body?.cancel().catch(() => {});
    result = await fetchWithRouteProxy(target, init, routeProxyConfig, timeoutMs);
  }
  return result;
}



interface ProxyHandlerDeps {
  store: JsonStore;
  markTemporaryAccountAttempt: (candidate: ProxyExecutionCandidate, statusCode: number, errorMessage?: string) => void;
  markCandidateSuccess: (route: RouteRecord, candidate: ProxyExecutionCandidate) => void;
  resolveProxyExecution: (routeNameOrId: string) => { route: RouteRecord; candidates: ProxyExecutionCandidate[] };
}

export function createProxyHandler({ store, markTemporaryAccountAttempt, markCandidateSuccess, resolveProxyExecution }: ProxyHandlerDeps) {
  function routeCreatedSeconds(route: RouteRecord) {
    const timestamp = Date.parse(route.createdAt);
    return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
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


  async function handleProxy(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
    const startedAt = Date.now();
    const upstreamTimeoutMs = store.getDb().settings.requestTimeoutSeconds * 1000;
    // One AbortController per client request. If the client hangs up (browser stop, curl Ctrl-C, etc.)
    // we abort the upstream fetch and release the undici pool slot immediately.
    // `IncomingMessage.close` also fires after a normal request body read, so only use the explicit
    // abort event and an unfinished response close as disconnect signals.
    const clientAbort = new AbortController();
    const abortClientRequest = () => {
      if (!clientAbort.signal.aborted) clientAbort.abort();
    };
    request.once("aborted", abortClientRequest);
    response.once("close", () => {
      if (!response.writableEnded) abortClientRequest();
    });
    const baseLog = {
      routeName: "unknown",
      method: request.method || "POST",
      path: url.pathname,
      providerName: "未匹配",
      model: "未匹配",
      userAgent: valueToHeaderText(request.headers["user-agent"]),
      clientIp: requestClientIp(request),
      clientDevice: clientDeviceFromUserAgent(valueToHeaderText(request.headers["user-agent"])),
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
    let requestLogBase: typeof baseLog & { routeName: string; apiKeyId?: string; apiKeyName?: string } = {
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

    if (authenticatedApiKey !== true) {
      requestLogBase = {
        ...requestLogBase,
        apiKeyId: authenticatedApiKey.id,
        apiKeyName: authenticatedApiKey.name
      };
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
      const upstreamAttempts: RequestLogUpstreamRequest[] = [];
      type UpstreamAttempt = RequestLogUpstreamRequest;
      const recordAttemptLog = (input: {
        candidate: ProxyExecutionCandidate;
        attempt: UpstreamAttempt;
        routeUa: string;
        routeTargetLog: RequestLog["routeTarget"];
        upstreamAuthLog: Record<string, string>;
        proxy?: RequestLog["proxy"];
        proxyConfig?: SiteAddress["proxy"];
      }) => store.recordRequestLog({
        ...requestLogBase,
        routeId: route.id,
        routeName: route.name,
        endpoint: route.endpoint,
        providerName: input.candidate.site.name,
        providerId: input.candidate.site.id,
        addressLabel: input.attempt.addressLabel,
        model: input.candidate.model,
        requestBody: body,
        status: input.attempt.status,
        statusCode: input.attempt.statusCode,
        durationMs: input.attempt.durationMs,
        requestHeaders: {
          ...requestLogBase.requestHeaders,
          ...input.upstreamAuthLog
        },
        upstreamUrl: input.attempt.upstreamUrl,
        upstreamContentType: input.attempt.contentType,
        responsePreview: input.attempt.responsePreview,
        errorMessage: input.attempt.errorMessage,
        downstream: downstreamLog,
        routeTarget: input.routeTargetLog,
        upstreamRequest: input.attempt,
        proxy: input.proxy || requestLogProxyForRoute(input.proxyConfig),
        summary: chainSummary({
          downstreamModel: downstreamLog.model,
          downstreamEndpoint,
          downstreamUa,
          routeModel: input.candidate.model,
          routeEndpoint: route.endpoint,
          routeUa: input.routeUa,
          status: input.attempt.status
        })
      });

      for (const candidate of candidates) {
        const candidateProxy = candidate.addresses[0]?.proxy || { mode: "direct" as const };
        const templateHeaders = parseHeaderTemplate(candidate.headerTemplate?.headersText);
        const useDownstreamHeaders = userAgentsHaveSameClient(
          downstreamUa,
          headerValue(templateHeaders, "User-Agent")
        );
        const headers = useDownstreamHeaders
          ? forwardableRequestHeaders(request.headers)
          : templateHeaders;
        if (useDownstreamHeaders) {
          // These values authenticate the caller to SamAPI and must never become upstream credentials.
          deleteHeader(headers, "Authorization");
          deleteHeader(headers, "X-API-Key");
        }
        setHeader(headers, "Content-Type", "application/json");
        if (!candidate.providerApiKey && !candidate.temporaryAccount && !candidate.temporaryApiKeyAccount && !headerValue(headers, "Authorization")) {
          throw new Error(`未找到支持模型 ${candidate.model} 的上游 API Key`);
        }
        if (candidate.providerApiKey) setHeader(headers, "Authorization", `Bearer ${candidate.providerApiKey.secret}`);
        let grokAccount = isGrokOAuthTemporaryAccount(candidate.temporaryApiKeyAccount)
          ? candidate.temporaryApiKeyAccount
          : undefined;
        if (grokAccount && grokOAuthAccessTokenNeedsRefresh(grokAccount)) {
          try {
            const tokenPatch = await refreshGrokOAuthTemporaryAccountToken(grokAccount, candidateProxy);
            if (!tokenPatch) throw new Error("Grok OAuth 账号缺少可用 access_token 和 refresh_token");
            store.updateTemporaryAccountCheckResult(grokAccount.id, tokenPatch);
            grokAccount = { ...grokAccount, ...tokenPatch };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "刷新 Grok OAuth token 失败";
            markTemporaryAccountAttempt(candidate, 401, errorMessage);
            errors.push(`${candidate.temporaryApiKeyAccount?.label || "Grok OAuth"}：${errorMessage}`);
            continue;
          }
        }
        if (grokAccount) Object.assign(headers, grokOAuthHeaders(grokAccount, grokAccount.secret, downstreamStream, undefined, candidate.model));
        const executionEndpoint: RouteEndpointKind = grokAccount ? "responses" : route.endpoint;
        const executionAddresses = grokAccount
          ? [{
              id: `grok-oauth-${grokAccount.id}`,
              label: grokAccount.grokOAuthFormat === "grok2api-oauth" ? "Grok Build (grok2api)" : "Grok OAuth (CPA)",
              baseUrl: grokOAuthBaseUrl(grokAccount),
              enabled: true,
              models: [candidate.model],
              proxy: candidateProxy
            }]
          : candidate.addresses;
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
                "upstream-authorization": `Bearer ${maskSecret(candidate.temporaryApiKeyAccount.secret)}`,
                ...(grokAccount ? { "upstream-auth-format": grokAccount.grokOAuthFormat || "cpa-oauth" } : {})
              }
          : {
              "upstream-authorization": "Header 模版已提供"
        };
        const converted = convertedRouteRequestBody(body, candidate.model, executionEndpoint, proxyInfo.kind);
        const sanitizedBody = sanitizeOpenAiCompatibleResponsesBody(converted.body, executionEndpoint);
        // Grok speaks the Responses protocol but only supports `function` tools. Codex declares some
        // tools as `custom`; we forward them as functions and then map Grok's function_call replies
        // back to custom_tool_call so Codex accepts them. This converter runs only for those tools.
        const grokCustomTools = grokAccount ? grokCustomToolNames(sanitizedBody) : undefined;
        const responseConverter =
          grokCustomTools && grokCustomTools.size > 0
            ? createGrokResponsesToolConverter(grokCustomTools)
            : converted.converter;
        const grokBody = grokAccount ? grokOAuthRequestBody(sanitizedBody, candidate.model) : sanitizedBody;
        let forwardedBody = downstreamStream ? applyStreamingFlag(grokBody, true) : grokBody;
        // Grok rejects a request when it carries encrypted reasoning it did not mint (cross-provider
        // routing). We retry once with that reasoning stripped; this guard prevents an infinite loop.
        let grokEncryptedRetryUsed = false;
        const upstreamRequestHeaders = {
          ...maskedStringHeaders(headers),
          ...upstreamAuthLog
        };
        lastAttemptContext = { candidate, routeUa, routeTargetLog, upstreamAuthLog };

        if (candidate.temporaryAccount) {
          let codexAccount = candidate.temporaryAccount;
          const agentIdentity = isOpenAiAgentIdentityAccount(codexAccount);
          if (agentIdentity) {
            codexAccount = await ensureOpenAiAgentIdentityTask({
              account: codexAccount,
              proxy: candidateProxy,
              getCurrent: () => store.temporaryAccountCheckTarget(codexAccount.id)?.account,
              persist: (agentTaskId) => { store.updateTemporaryAccountCheckResult(codexAccount.id, { agentTaskId }); }
            });
          }
          let codexHeaders = codexTemporaryHeaders(codexAccount, headers, true);
          if (agentIdentity) setHeader(codexHeaders, "Authorization", agentIdentityAuthorization(codexAccount));
          const codexRouteUa = headerValue(codexHeaders, "User-Agent") || CODEX_USER_AGENT;
          const codexRouteTargetLog = {
            ...routeTargetLog,
            userAgent: codexRouteUa
          };
          const codexAuthLog: Record<string, string> = {
            "upstream-api-key": candidate.temporaryAccount.label,
            "upstream-auth-format": agentIdentity ? "agent-identity" : "oauth-bearer",
            "upstream-authorization": agentIdentity ? "AgentAssertion [redacted]" : `Bearer ${maskSecret(candidate.temporaryAccount.secret)}`,
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
            let { response: upstream, proxy: attemptProxy } = await fetchWith429Retry(CODEX_BACKEND_RESPONSES_URL, {
              method: "POST",
              headers: codexHeaders,
              body: JSON.stringify(codexForwardedBody),
              signal: clientAbort.signal
            }, candidateProxy, upstreamTimeoutMs);
            // Recover an invalid/expired task exactly once. The expected ID prevents concurrent
            // requests from registering a second task after another request already recovered it.
            if (agentIdentity && upstream.status === 401) {
              const invalidBody = await upstream.clone().text();
              if (isOpenAiAgentIdentityTaskInvalid(upstream.status, invalidBody)) {
                const expectedTaskId = codexAccount.agentTaskId;
                codexAccount = await ensureOpenAiAgentIdentityTask({
                  account: codexAccount,
                  proxy: candidateProxy,
                  expectedTaskId,
                  getCurrent: () => store.temporaryAccountCheckTarget(codexAccount.id)?.account,
                  persist: (agentTaskId) => { store.updateTemporaryAccountCheckResult(codexAccount.id, { agentTaskId }); }
                });
                codexHeaders = codexTemporaryHeaders(codexAccount, headers, true);
                setHeader(codexHeaders, "Authorization", agentIdentityAuthorization(codexAccount));
                ({ response: upstream, proxy: attemptProxy } = await fetchWith429Retry(CODEX_BACKEND_RESPONSES_URL, {
                  method: "POST", headers: codexHeaders, body: JSON.stringify(codexForwardedBody), signal: clientAbort.signal
                }, candidateProxy, upstreamTimeoutMs));
              }
            }
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
                  durationMs: Date.now() - attemptStartedAt,
                  requestHeaders: {
                    ...requestLogBase.requestHeaders,
                    ...codexAuthLog
                  },
                  upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                  upstreamContentType: contentType,
                  downstream: downstreamLog,
                  routeTarget: codexRouteTargetLog,
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
                      : await streamRawResponse({ upstreamBody: upstream.body, response, proxyKind: proxyInfo.kind });
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
                    durationMs: Date.now() - attemptStartedAt,
                    requestHeaders: {
                      ...requestLogBase.requestHeaders,
                      ...codexAuthLog
                    },
                    upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                    upstreamContentType: contentType,
                    responsePreview: responsePreview(streamPreviewText),
                    downstream: downstreamLog,
                    routeTarget: codexRouteTargetLog,
                    upstreamRequest: upstreamAttempts[upstreamAttempts.length - 1],
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
                  // Actively release the upstream socket: if the client disconnected mid-stream we
                  // must cancel the ReadableStream, otherwise undici keeps the socket "in use" until
                  // the upstream itself decides to close — which is exactly how the pool leaked.
                  upstream.body?.cancel().catch(() => {});
                  const clientCancelled = isClientAbortError(clientAbort.signal, streamError);
                  const errorMessage = clientCancelled
                    ? "客户端已中止请求"
                    : streamError instanceof Error
                      ? streamError.message
                      : "Codex 流式转发失败";
                  const streamStatus = clientCancelled ? "cancelled" as const : "failed" as const;
                  const streamStatusCode = clientCancelled ? 499 : 599;
                  if (!clientCancelled) markTemporaryAccountAttempt(candidate, 599, errorMessage);
                  upstreamAttempts.push({
                    addressLabel: "Codex Backend",
                    upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                    method: "POST",
                    model: candidate.model,
                    endpoint: "responses",
                    userAgent: codexRouteUa,
                    requestHeaders: codexUpstreamRequestHeaders,
                    requestBody: codexForwardedBody,
                    status: streamStatus,
                    statusCode: streamStatusCode,
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
                    status: streamStatus,
                    statusCode: streamStatusCode,
                    durationMs: Date.now() - attemptStartedAt,
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
                    upstreamRequest: upstreamAttempts[upstreamAttempts.length - 1],
                    proxy: attemptProxy,
                    summary: chainSummary({
                      downstreamModel: downstreamLog.model,
                      downstreamEndpoint,
                      downstreamUa,
                      routeModel: candidate.model,
                      routeEndpoint: route.endpoint,
                      routeUa: codexRouteUa,
                      status: streamStatus
                    })
                  });
                  if (clientCancelled) {
                    if (!response.writableEnded) response.destroy();
                  } else {
                    response.end();
                  }
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
                durationMs: Date.now() - attemptStartedAt,
                requestHeaders: {
                  ...requestLogBase.requestHeaders,
                  ...codexAuthLog
                },
                upstreamUrl: CODEX_BACKEND_RESPONSES_URL,
                upstreamContentType: contentType,
                responsePreview: responsePreview(adapted.text || codexCollected.preview),
                downstream: downstreamLog,
                routeTarget: codexRouteTargetLog,
                upstreamRequest: upstreamAttempts[upstreamAttempts.length - 1],
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

            const rawText = await upstream.text();
            const text = agentIdentity ? redactOpenAiAgentIdentityText(rawText, codexAccount) : rawText;
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
            recordAttemptLog({
              candidate,
              attempt: upstreamAttempts[upstreamAttempts.length - 1],
              routeUa: codexRouteUa,
              routeTargetLog: codexRouteTargetLog,
              upstreamAuthLog: codexAuthLog,
              proxy: attemptProxy,
              proxyConfig: candidateProxy
            });
            lastFailure = {
              address: candidate.addresses[0],
              target: CODEX_BACKEND_RESPONSES_URL,
              statusCode: upstream.status,
              text,
              contentType
            };
          } catch (error) {
            if (clientAbort.signal.aborted || (error as { name?: string } | undefined)?.name === "AbortError") throw error;
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
            recordAttemptLog({
              candidate,
              attempt: upstreamAttempts[upstreamAttempts.length - 1],
              routeUa: codexRouteUa,
              routeTargetLog: codexRouteTargetLog,
              upstreamAuthLog: codexAuthLog,
              proxyConfig: candidateProxy
            });
          }
          continue;
        }

        for (const address of executionAddresses) {
        const addressTargets = proxyEndpointCandidates(address.baseUrl, executionEndpoint);
        for (let targetIndex = 0; targetIndex < addressTargets.length; targetIndex += 1) {
          const target = addressTargets[targetIndex];
          const attemptStartedAt = Date.now();
          try {
            const { response: upstream, proxy: attemptProxy } = await fetchWith429Retry(target, {
              method: request.method || "POST",
              headers,
              body: JSON.stringify(forwardedBody),
              signal: clientAbort.signal
            }, address.proxy, upstreamTimeoutMs);
            const contentType = upstream.headers.get("content-type") || undefined;

            // Grok cross-provider reasoning fix: on the "could not decrypt encrypted_content" error we
            // strip the foreign encrypted reasoning and retry the same target once (peek via clone so
            // the original body stays readable for the normal failure path if this is not the case).
            if (grokAccount && !upstream.ok && !grokEncryptedRetryUsed) {
              const peekText = await upstream.clone().text().catch(() => "");
              if (isGrokEncryptedContentError(peekText)) {
                const stripped = stripGrokEncryptedReasoning(forwardedBody);
                if (stripped) {
                  grokEncryptedRetryUsed = true;
                  forwardedBody = downstreamStream ? applyStreamingFlag(stripped, true) : stripped;
                  upstream.body?.cancel().catch(() => {});
                  targetIndex -= 1;
                  continue;
                }
              }
            }

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
                  durationMs: Date.now() - attemptStartedAt,
                  requestHeaders: {
                    ...requestLogBase.requestHeaders,
                    ...upstreamAuthLog
                  },
                  upstreamUrl: target,
                  upstreamContentType: contentType,
                  downstream: downstreamLog,
                  routeTarget: routeTargetLog,
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
                          routeEndpoint: executionEndpoint,
                          routeModel: candidate.model,
                          requestBody: forwardedBody,
                          converter: responseConverter
                        })
                      : await streamRawResponse({ upstreamBody: upstream.body, response, proxyKind: proxyInfo.kind });
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
                    durationMs: Date.now() - attemptStartedAt,
                    requestHeaders: {
                      ...requestLogBase.requestHeaders,
                      ...upstreamAuthLog
                    },
                    upstreamUrl: target,
                    upstreamContentType: contentType,
                    responsePreview: responsePreview(streamPreviewText),
                    downstream: downstreamLog,
                    routeTarget: routeTargetLog,
                    upstreamRequest: upstreamAttempts[upstreamAttempts.length - 1],
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
                  // Same rationale as the Codex branch: release the upstream socket promptly so the
                  // undici pool doesn't fill up with in-use slots after a client-side abort.
                  upstream.body?.cancel().catch(() => {});
                  const clientCancelled = isClientAbortError(clientAbort.signal, streamError);
                  const errorMessage = clientCancelled
                    ? "客户端已中止请求"
                    : streamError instanceof Error
                      ? streamError.message
                      : "流式转发失败";
                  const streamStatus = clientCancelled ? "cancelled" as const : "failed" as const;
                  const streamStatusCode = clientCancelled ? 499 : 599;
                  if (!clientCancelled) markTemporaryAccountAttempt(candidate, 599, errorMessage);
                  upstreamAttempts.push({
                    addressLabel: address.label,
                    upstreamUrl: target,
                    method: request.method || "POST",
                    model: candidate.model,
                    endpoint: route.endpoint,
                    userAgent: routeUa,
                    requestHeaders: upstreamRequestHeaders,
                    requestBody: forwardedBody,
                    status: streamStatus,
                    statusCode: streamStatusCode,
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
                    status: streamStatus,
                    statusCode: streamStatusCode,
                    durationMs: Date.now() - attemptStartedAt,
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
                    upstreamRequest: upstreamAttempts[upstreamAttempts.length - 1],
                    proxy: attemptProxy,
                    summary: chainSummary({
                      downstreamModel: downstreamLog.model,
                      downstreamEndpoint,
                      downstreamUa,
                      routeModel: candidate.model,
                      routeEndpoint: route.endpoint,
                      routeUa,
                      status: streamStatus
                    })
                  });
                  if (clientCancelled) {
                    if (!response.writableEnded) response.destroy();
                  } else {
                    response.end();
                  }
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
                recordAttemptLog({
                  candidate,
                  attempt: upstreamAttempts[upstreamAttempts.length - 1],
                  routeUa,
                  routeTargetLog,
                  upstreamAuthLog,
                  proxy: attemptProxy,
                  proxyConfig: address.proxy
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
                durationMs: Date.now() - attemptStartedAt,
                requestHeaders: {
                  ...requestLogBase.requestHeaders,
                  ...upstreamAuthLog
                },
                upstreamUrl: target,
                upstreamContentType: contentType,
                responsePreview: responsePreview(adapted.text),
                downstream: downstreamLog,
                routeTarget: routeTargetLog,
                upstreamRequest: upstreamAttempts[upstreamAttempts.length - 1],
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
            recordAttemptLog({
              candidate,
              attempt: upstreamAttempts[upstreamAttempts.length - 1],
              routeUa,
              routeTargetLog,
              upstreamAuthLog,
              proxy: attemptProxy,
              proxyConfig: address.proxy
            });
            lastFailure = {
              address,
              target,
              statusCode: upstream.status,
              text,
              contentType
            };
          } catch (error) {
            if (clientAbort.signal.aborted || (error as { name?: string } | undefined)?.name === "AbortError") throw error;
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
            recordAttemptLog({
              candidate,
              attempt: upstreamAttempts[upstreamAttempts.length - 1],
              routeUa,
              routeTargetLog,
              upstreamAuthLog,
              proxyConfig: address.proxy
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
      if (upstreamAttempts.length === 0) {
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
          proxy: requestLogProxyForRoute(failedAddress?.proxy),
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
      }
      if (lastFailure?.text) {
        const upstreamUrl = lastFailure.target;
        response.writeHead(lastFailure.statusCode, {
          "Content-Type": lastFailure.contentType || "application/json; charset=utf-8",
          "X-SamAPI-Upstream-URL": upstreamUrl,
          "Access-Control-Expose-Headers": "X-SamAPI-Upstream-URL",
          "Access-Control-Allow-Origin": "*"
        });
        response.end(appendUpstreamUrlToErrorResponse(lastFailure.text, lastFailure.contentType, upstreamUrl));
        return;
      }
      sendJson(response, 502, { error: message });
    } catch (error) {
      // Client-initiated abort: don't spam a 502 into a socket that's already gone, but do log so
      // the request shows up in the UI (empty log page was the biggest symptom of the leak).
      const clientCancelled = isClientAbortError(clientAbort.signal, error);
      const message = clientCancelled
        ? "客户端已中止请求"
        : error instanceof Error
          ? error.message
          : "Proxy failed";
      store.recordRequestLog({
        ...requestLogBase,
        ...routeLogContext,
        requestBody: body,
        status: clientCancelled ? "cancelled" : "failed",
        statusCode: clientCancelled ? 499 : 502,
        durationMs: Date.now() - startedAt,
        errorMessage: message
      });
      if (clientCancelled) {
        if (!response.writableEnded) response.destroy();
        return;
      }
      if (!response.headersSent) sendJson(response, 502, { error: message });
      else if (!response.writableEnded) response.end();
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
      clientIp: requestClientIp(request),
      clientDevice: clientDeviceFromUserAgent(valueToHeaderText(request.headers["user-agent"])),
      requestHeaders: maskRequestHeaders(request.headers),
      requestBody: body,
      status: "failed",
      statusCode: 404,
      durationMs: Date.now() - startedAt,
      errorMessage: unsupportedProxyMessage()
    });
    sendJson(response, 404, { error: unsupportedProxyMessage() });
  }


  return { handleProxy, handleUnsupportedProxyPath };
}
