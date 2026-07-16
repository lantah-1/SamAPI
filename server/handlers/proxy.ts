import http from "node:http";
import { URL } from "node:url";
import type { JsonStore } from "../store.js";
import {
  extractUpstreamError,
  headerValue,
  looksLikeHtml,
  maskedStringHeaders,
  maskRequestHeaders,
  maskSecret,
  requestApiKey,
  requestModelName,
  responsePreview,
  setHeader
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
  grokOAuthAccessTokenNeedsRefresh,
  grokOAuthBaseUrl,
  grokOAuthHeaders,
  isGrokOAuthTemporaryAccount,
  refreshGrokOAuthTemporaryAccountToken
} from "../providers/grok.js";
import type { ProxyExecutionCandidate } from "../routing.js";
import type { RequestLog, RequestLogStatus, RouteRecord, SiteAddress } from "../../shared/types.js";

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
        let grokAccount = isGrokOAuthTemporaryAccount(candidate.temporaryApiKeyAccount)
          ? candidate.temporaryApiKeyAccount
          : undefined;
        if (grokAccount && grokOAuthAccessTokenNeedsRefresh(grokAccount)) {
          try {
            const tokenPatch = await refreshGrokOAuthTemporaryAccountToken(grokAccount, route.proxy);
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
              models: [candidate.model]
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
        const responseConverter = converted.converter;
        const sanitizedBody = sanitizeOpenAiCompatibleResponsesBody(converted.body, executionEndpoint);
        const forwardedBody = downstreamStream ? applyStreamingFlag(sanitizedBody, true) : sanitizedBody;
        const upstreamRequestHeaders = {
          ...maskedStringHeaders(headers),
          ...upstreamAuthLog
        };
        lastAttemptContext = { candidate, routeUa, routeTargetLog, upstreamAuthLog };

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
              body: JSON.stringify(codexForwardedBody),
              signal: clientAbort.signal
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
                  // Actively release the upstream socket: if the client disconnected mid-stream we
                  // must cancel the ReadableStream, otherwise undici keeps the socket "in use" until
                  // the upstream itself decides to close — which is exactly how the pool leaked.
                  upstream.body?.cancel().catch(() => {});
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
          }
          continue;
        }

        for (const address of executionAddresses) {
        for (const target of proxyEndpointCandidates(address.baseUrl, executionEndpoint)) {
          const attemptStartedAt = Date.now();
          try {
            const { response: upstream, proxy: attemptProxy } = await fetchWithRouteProxy(target, {
              method: request.method || "POST",
              headers,
              body: JSON.stringify(forwardedBody),
              signal: clientAbort.signal
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
                  // Same rationale as the Codex branch: release the upstream socket promptly so the
                  // undici pool doesn't fill up with in-use slots after a client-side abort.
                  upstream.body?.cancel().catch(() => {});
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
      // Client-initiated abort: don't spam a 502 into a socket that's already gone, but do log so
      // the request shows up in the UI (empty log page was the biggest symptom of the leak).
      const isClientAbort =
        clientAbort.signal.aborted ||
        (error as { name?: string } | undefined)?.name === "AbortError";
      const message = isClientAbort
        ? "客户端已中止请求"
        : error instanceof Error
          ? error.message
          : "Proxy failed";
      store.recordRequestLog({
        ...requestLogBase,
        ...routeLogContext,
        requestBody: body,
        status: "failed",
        statusCode: isClientAbort ? 499 : 502,
        durationMs: Date.now() - startedAt,
        errorMessage: message
      });
      if (isClientAbort) {
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


  return { handleProxy, handleUnsupportedProxyPath };
}
