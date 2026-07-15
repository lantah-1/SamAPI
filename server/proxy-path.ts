import http from "node:http";
import { URL } from "node:url";
import { requestModelName } from "./util/text.js";

export type ProxyKind = "generic" | "models" | "messages" | "chat-completions" | "responses" | "gemini-generate" | "gemini-stream";
export type RouteEndpointKind = "messages" | "chat/completions" | "responses";
export type RosettaConverter = {
  convertRequest: (payload: unknown) => unknown;
  convertResponse: (payload: unknown) => unknown;
  convertStream?: (stream: AsyncIterable<unknown>) => AsyncIterable<unknown>;
};

export function normalizedProxyPath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

export function proxyPathInfo(pathname: string): { supported: boolean; kind: ProxyKind; routeNameFromPath?: string } {
  const normalized = normalizedProxyPath(pathname);
  if (normalized === "/proxy") return { supported: true, kind: "generic" };
  if (["/proxy/models", "/proxy/v1/models", "/proxy/v1beta/models"].includes(normalized)) return { supported: true, kind: "models" };
  if (["/proxy/messages", "/proxy/v1/messages"].includes(normalized)) return { supported: true, kind: "messages" };
  if (
    [
      "/proxy/chat/complete",
      "/proxy/v1/chat/complete",
      "/proxy/chat/completion",
      "/proxy/v1/chat/completion",
      "/proxy/chat/completions",
      "/proxy/v1/chat/completions"
    ].includes(normalized)
  ) {
    return { supported: true, kind: "chat-completions" };
  }
  if (["/proxy/response", "/proxy/v1/response", "/proxy/responses", "/proxy/v1/responses"].includes(normalized)) {
    return { supported: true, kind: "responses" };
  }

  const geminiMatch = normalized.match(/^\/proxy\/(?:v1|v1beta)\/models\/([^/]+):(generateContent|streamGenerateContent)$/);
  if (geminiMatch) {
    return {
      supported: true,
      kind: geminiMatch[2] === "streamGenerateContent" ? "gemini-stream" : "gemini-generate",
      routeNameFromPath: decodeURIComponent(geminiMatch[1])
    };
  }
  return { supported: false, kind: "generic" };
}

export function proxyRouteName(pathname: string, body: unknown) {
  return proxyPathInfo(pathname).routeNameFromPath || requestModelName(body);
}

export function isSupportedProxyPath(pathname: string) {
  return proxyPathInfo(pathname).supported;
}

export function unsupportedProxyMessage() {
  return "代理入口支持 /proxy、/proxy/v1/models、/proxy/v1/messages、/proxy/v1/chat/completions、/proxy/v1/responses 和 /proxy/v1beta/models/{model}:generateContent";
}

export function proxyKindLabel(kind: ProxyKind, pathname: string) {
  if (kind === "generic") return "proxy";
  if (kind === "models") return "models";
  if (kind === "messages") return "messages";
  if (kind === "chat-completions") return "chat/completions";
  if (kind === "responses") return "responses";
  if (kind === "gemini-generate") return "gemini:generateContent";
  if (kind === "gemini-stream") return "gemini:streamGenerateContent";
  return pathname;
}

export function wantsAnthropicModelsFormat(request: http.IncomingMessage, url: URL) {
  return Boolean(
    url.searchParams.get("format") === "anthropic" ||
      request.headers["anthropic-version"] ||
      request.headers["anthropic-beta"] ||
      request.headers["anthropic-dangerous-direct-browser-access"]
  );
}
