import http from "node:http";
import { URL } from "node:url";
import {
  ChatCompletionToMessagesConverter,
  ChatCompletionToResponsesConverter,
  GeminiToChatCompletionConverter,
  GeminiToMessagesConverter,
  GeminiToResponsesConverter,
  MessagesToChatCompletionConverter,
  MessagesToResponsesConverter,
  ResponsesToChatCompletionConverter,
  ResponsesToMessagesConverter
} from "@zenmux/rosetta-ai";
import { JsonStore, parseHeaderTemplate } from "./store.js";
import type { RequestLog, RequestLogStatus, Site, SiteAddress } from "../shared/types.js";

const PORT = Number(process.env.SAMAPI_PORT || 8787);
const HOST = process.env.SAMAPI_HOST || "0.0.0.0";
const store = new JsonStore();

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-Key"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function routeParam(parts: string[], index: number) {
  return decodeURIComponent(parts[index] || "");
}

function notFound(response: http.ServerResponse) {
  sendJson(response, 404, { error: "Not found" });
}

function valueToHeaderText(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(", ");
  return value || "";
}

function maskRequestHeaders(headers: http.IncomingHttpHeaders) {
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

function responsePreview(text: string) {
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

function compactPreview(text: string) {
  return responsePreview(text.replace(/\s+/g, " ").trim());
}

function maskSecret(secret: string) {
  const trimmed = secret.trim();
  return trimmed ? `${trimmed.slice(0, 10)}...` : "";
}

function extractUpstreamError(text: string) {
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

function joinUrl(baseUrl: string, suffix: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function requestModelName(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const model = (body as { model?: unknown }).model;
  return typeof model === "string" ? model.trim() : "";
}

type ProxyKind = "generic" | "messages" | "chat-completions" | "responses" | "gemini-generate" | "gemini-stream";
type RouteEndpointKind = "messages" | "chat/completions" | "responses";
type RosettaConverter = {
  convertRequest: (payload: unknown) => unknown;
  convertResponse: (payload: unknown) => unknown;
  convertStream?: (stream: AsyncIterable<unknown>) => AsyncIterable<unknown>;
};

function normalizedProxyPath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/proxy";
}

function proxyPathInfo(pathname: string): { supported: boolean; kind: ProxyKind; routeNameFromPath?: string } {
  const normalized = normalizedProxyPath(pathname);
  if (normalized === "/proxy") return { supported: true, kind: "generic" };
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

function proxyRouteName(pathname: string, body: unknown) {
  return proxyPathInfo(pathname).routeNameFromPath || requestModelName(body);
}

function isSupportedProxyPath(pathname: string) {
  return proxyPathInfo(pathname).supported;
}

function textFromContent(value: unknown): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function bodyRecord(body: unknown) {
  return isRecord(body) ? body : {};
}

function systemText(value: unknown) {
  return textFromContent(value);
}

function anthropicContentToText(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return "";
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "tool_result") {
        return typeof item.content === "string" ? item.content : textFromContent(item.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicMessagesToOpenAiMessages(body: unknown) {
  const source = bodyRecord(body);
  const messages: Array<Record<string, unknown>> = [];
  const system = systemText(source.system);
  if (system) messages.push({ role: "system", content: system });

  const sourceMessages = Array.isArray(source.messages) ? source.messages : [];
  for (const message of sourceMessages) {
    if (!isRecord(message)) continue;
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
    const content = message.content;

    if (role === "assistant" && Array.isArray(content)) {
      const toolCalls = content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "tool_use")
        .map((part, index) => ({
          id: typeof part.id === "string" ? part.id : `tool-${index + 1}`,
          type: "function",
          function: {
            name: typeof part.name === "string" ? part.name : "tool",
            arguments: JSON.stringify(isRecord(part.input) ? part.input : {})
          }
        }));
      messages.push({
        role,
        content: anthropicContentToText(content) || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    if (role === "user" && Array.isArray(content)) {
      const toolResults = content.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "tool_result");
      if (toolResults.length > 0) {
        for (const part of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: typeof part.tool_use_id === "string" ? part.tool_use_id : "tool",
            content: typeof part.content === "string" ? part.content : textFromContent(part.content)
          });
        }
        const plainText = anthropicContentToText(content.filter((part) => !isRecord(part) || part.type !== "tool_result"));
        if (plainText) messages.push({ role: "user", content: plainText });
        continue;
      }
    }

    messages.push({ role, content: anthropicContentToText(content) || "" });
  }
  return messages;
}

function anthropicToolsToOpenAiChatTools(body: unknown) {
  const tools = bodyRecord(body).tools;
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter((tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} }
      }
    }));
  return converted.length > 0 ? converted : undefined;
}

function anthropicToolsToOpenAiResponseTools(body: unknown) {
  const tools = bodyRecord(body).tools;
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter((tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} }
    }));
  return converted.length > 0 ? converted : undefined;
}

function anthropicToolChoiceToOpenAiChat(body: unknown) {
  const toolChoice = bodyRecord(body).tool_choice;
  if (!isRecord(toolChoice)) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

function commonGenerationOptions(body: unknown) {
  const source = bodyRecord(body);
  return {
    ...(typeof source.temperature === "number" ? { temperature: source.temperature } : {}),
    ...(typeof source.top_p === "number" ? { top_p: source.top_p } : {}),
    ...(typeof source.max_tokens === "number" ? { max_tokens: source.max_tokens } : {}),
    ...(Array.isArray(source.stop_sequences) ? { stop: source.stop_sequences } : {})
  };
}

function anthropicMessagesToOpenAiChatBody(body: unknown, routeModel: string) {
  const source = bodyRecord(body);
  const tools = anthropicToolsToOpenAiChatTools(body);
  const toolChoice = anthropicToolChoiceToOpenAiChat(body);
  return {
    model: routeModel,
    messages: anthropicMessagesToOpenAiMessages(body),
    ...commonGenerationOptions(body),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(typeof source.stream === "boolean" ? { stream: false } : {})
  };
}

function anthropicMessagesToOpenAiResponsesBody(body: unknown, routeModel: string) {
  const source = bodyRecord(body);
  const tools = anthropicToolsToOpenAiResponseTools(body);
  const options = commonGenerationOptions(body);
  const { max_tokens, ...restOptions } = options;
  return {
    model: routeModel,
    input: anthropicMessagesToOpenAiMessages(body),
    ...(max_tokens ? { max_output_tokens: max_tokens } : {}),
    ...restOptions,
    ...(tools ? { tools } : {}),
    ...(typeof source.stream === "boolean" ? { stream: false } : {})
  };
}

function isStreamingRequest(body: unknown) {
  return bodyRecord(body).stream === true;
}

function rosettaConverter(proxyKind: ProxyKind, routeEndpoint: RouteEndpointKind): RosettaConverter | undefined {
  if (proxyKind === "messages") {
    if (routeEndpoint === "chat/completions") return new MessagesToChatCompletionConverter() as RosettaConverter;
    if (routeEndpoint === "responses") return new MessagesToResponsesConverter() as RosettaConverter;
  }
  if (proxyKind === "chat-completions" || proxyKind === "generic") {
    if (routeEndpoint === "messages") return new ChatCompletionToMessagesConverter() as RosettaConverter;
    if (routeEndpoint === "responses") return new ChatCompletionToResponsesConverter() as RosettaConverter;
  }
  if (proxyKind === "responses") {
    if (routeEndpoint === "messages") return new ResponsesToMessagesConverter() as RosettaConverter;
    if (routeEndpoint === "chat/completions") return new ResponsesToChatCompletionConverter() as RosettaConverter;
  }
  if (proxyKind === "gemini-generate" || proxyKind === "gemini-stream") {
    if (routeEndpoint === "messages") return new GeminiToMessagesConverter() as RosettaConverter;
    if (routeEndpoint === "chat/completions") return new GeminiToChatCompletionConverter() as RosettaConverter;
    if (routeEndpoint === "responses") return new GeminiToResponsesConverter() as RosettaConverter;
  }
  return undefined;
}

function applyRouteModel(payload: unknown, routeModel: string) {
  if (isRecord(payload)) return { ...payload, model: routeModel };
  return payload;
}

function normalizeGeminiConverterInput(body: unknown, routeModel: string) {
  const source = bodyRecord(body);
  const generationConfig = isRecord(source.generationConfig) ? source.generationConfig : {};
  return {
    ...source,
    model: routeModel,
    config: {
      ...generationConfig,
      ...(source.systemInstruction ? { systemInstruction: source.systemInstruction } : {}),
      ...(source.tools ? { tools: source.tools } : {}),
      ...(source.toolConfig ? { toolConfig: source.toolConfig } : {})
    }
  };
}

function convertedRouteRequestBody(body: unknown, routeModel: string, routeEndpoint: RouteEndpointKind, proxyKind: ProxyKind) {
  const converter = rosettaConverter(proxyKind, routeEndpoint);
  if (converter) {
    const source =
      proxyKind === "gemini-generate" || proxyKind === "gemini-stream"
        ? normalizeGeminiConverterInput(body, routeModel)
        : applyRouteModel(body, routeModel);
    const converted = converter.convertRequest(source);
    return {
      body: applyRouteModel(converted, routeModel),
      converter
    };
  }
  return {
    body: routeRequestBody(body, routeModel, routeEndpoint, proxyKind),
    converter: undefined
  };
}

function geminiContentsToMessages(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const contents = (body as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return [];
  return contents.map((content) => {
    if (!content || typeof content !== "object") return { role: "user", content: "" };
    const role = (content as { role?: unknown }).role === "model" ? "assistant" : "user";
    const parts = (content as { parts?: unknown }).parts;
    const text = Array.isArray(parts)
      ? parts
          .map((part) => {
            if (!part || typeof part !== "object") return "";
            const value = (part as { text?: unknown }).text;
            return typeof value === "string" ? value : "";
          })
          .filter(Boolean)
          .join("\n")
      : "";
    return { role, content: text };
  });
}

function geminiSystemText(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const instruction = (body as { systemInstruction?: unknown }).systemInstruction;
  if (!instruction || typeof instruction !== "object") return "";
  const parts = (instruction as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function geminiGenerationConfig(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const config = (body as { generationConfig?: unknown }).generationConfig;
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const source = config as Record<string, unknown>;
  return {
    ...(typeof source.temperature === "number" ? { temperature: source.temperature } : {}),
    ...(typeof source.topP === "number" ? { top_p: source.topP } : {}),
    ...(typeof source.maxOutputTokens === "number" ? { max_tokens: source.maxOutputTokens } : {})
  };
}

function routeRequestBody(body: unknown, routeModel: string, routeEndpoint: string, proxyKind: ProxyKind) {
  if (proxyKind === "gemini-generate" || proxyKind === "gemini-stream") {
    const messages = geminiContentsToMessages(body);
    const system = geminiSystemText(body);
    const config = geminiGenerationConfig(body);
    if (routeEndpoint === "messages") {
      return {
        model: routeModel,
        ...(system ? { system } : {}),
        messages: messages.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content
        })),
        ...config
      };
    }
    if (routeEndpoint === "chat/completions") {
      return {
        model: routeModel,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          ...messages
        ],
        ...config
      };
    }
    return {
      model: routeModel,
      input: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages
      ],
      ...config
    };
  }

  return body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), model: routeModel }
    : { input: body, model: routeModel };
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  if ("output_text" in payload && typeof (payload as { output_text?: unknown }).output_text === "string") {
    return (payload as { output_text: string }).output_text;
  }
  if ("content" in payload && Array.isArray((payload as { content?: unknown }).content)) {
    return textFromContent((payload as { content?: unknown }).content);
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    return choices
      .map((choice) => {
        if (!choice || typeof choice !== "object") return "";
        const message = (choice as { message?: unknown }).message;
        if (message && typeof message === "object") return textFromContent((message as { content?: unknown }).content);
        return textFromContent((choice as { text?: unknown }).text);
      })
      .filter(Boolean)
      .join("\n");
  }
  const output = (payload as { output?: unknown }).output;
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        return textFromContent((item as { content?: unknown }).content);
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function adaptResponseText(text: string, contentType: string | undefined, proxyKind: ProxyKind) {
  if (proxyKind !== "gemini-generate" && proxyKind !== "gemini-stream") return { text, contentType };
  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === "object" && "candidates" in payload) return { text, contentType };
    const extracted = extractResponseText(payload);
    if (!extracted) return { text, contentType };
    return {
      text: JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: extracted }]
            },
            finishReason: "STOP",
            index: 0
          }
        ]
      }),
      contentType: "application/json; charset=utf-8"
    };
  } catch {
    return { text, contentType };
  }
}

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicMessageToSse(message: unknown) {
  const record = bodyRecord(message);
  const content = Array.isArray(record.content) ? record.content : [];
  const startMessage = {
    ...record,
    content: [],
    stop_reason: null,
    stop_sequence: null
  };
  let output = sseEvent("message_start", { type: "message_start", message: startMessage });
  content.forEach((block, index) => {
    const contentBlock = isRecord(block) ? block : { type: "text", text: String(block || "") };
    output += sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: contentBlock.type === "text" ? { type: "text", text: "" } : contentBlock
    });
    if (contentBlock.type === "text" && typeof contentBlock.text === "string" && contentBlock.text) {
      output += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: contentBlock.text }
      });
    }
    output += sseEvent("content_block_stop", { type: "content_block_stop", index });
  });
  output += sseEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: typeof record.stop_reason === "string" ? record.stop_reason : "end_turn",
      stop_sequence: record.stop_sequence ?? null
    },
    usage: isRecord(record.usage) ? record.usage : { output_tokens: 0 }
  });
  output += sseEvent("message_stop", { type: "message_stop" });
  return output;
}

function convertUpstreamResponseText(input: {
  text: string;
  contentType?: string;
  proxyKind: ProxyKind;
  converter?: RosettaConverter;
  downstreamStream: boolean;
}) {
  if (input.converter) {
    try {
      const converted = input.converter.convertResponse(JSON.parse(input.text));
      if (input.proxyKind === "messages" && input.downstreamStream) {
        return {
          text: anthropicMessageToSse(converted),
          contentType: "text/event-stream; charset=utf-8"
        };
      }
      return {
        text: JSON.stringify(converted),
        contentType: "application/json; charset=utf-8"
      };
    } catch {
      // Fall through to compatibility conversion.
    }
  }
  const adapted = adaptResponseText(input.text, input.contentType, input.proxyKind);
  return {
    ...adapted,
    contentType: adapted.contentType || input.contentType
  };
}

function applyStreamingFlag(body: unknown, stream: boolean) {
  return isRecord(body) ? { ...body, stream } : body;
}

function maskedStringHeaders(headers: Record<string, string>) {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = ["authorization", "x-api-key", "cookie"].includes(key.toLowerCase()) ? "***" : value;
  }
  return masked;
}

function streamResponseContentType(proxyKind: ProxyKind, contentType?: string) {
  if (proxyKind === "messages" || proxyKind === "chat-completions" || proxyKind === "responses" || proxyKind === "generic") {
    return "text/event-stream; charset=utf-8";
  }
  return contentType || "text/event-stream; charset=utf-8";
}

async function writeResponseChunk(response: http.ServerResponse, chunk: string | Uint8Array) {
  if (response.write(chunk)) return;
  await new Promise<void>((resolve) => response.once("drain", resolve));
}

async function* textChunksFromReadable(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string) {
  let event = "";
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return { event, data: data.join("\n") };
}

async function* sseJsonObjectsFromReadable(stream: ReadableStream<Uint8Array>) {
  let buffer = "";
  for await (const chunk of textChunksFromReadable(stream)) {
    buffer += chunk;
    let separatorIndex = buffer.search(/\r?\n\r?\n/);
    while (separatorIndex >= 0) {
      const frame = buffer.slice(0, separatorIndex);
      const separator = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
      buffer = buffer.slice(separatorIndex + separator.length);
      const parsed = parseSseFrame(frame);
      if (parsed.data && parsed.data !== "[DONE]") {
        yield JSON.parse(parsed.data);
      }
      separatorIndex = buffer.search(/\r?\n\r?\n/);
    }
  }
  const parsed = parseSseFrame(buffer);
  if (parsed.data && parsed.data !== "[DONE]") yield JSON.parse(parsed.data);
  if (!parsed.data && buffer.trim().startsWith("{")) yield JSON.parse(buffer);
}

function hasReasoningRequest(body: unknown) {
  const source = bodyRecord(body);
  return Boolean(source.reasoning_effort || source.reasoning || source.thinking);
}

function shouldNormalizeReasoningContent(routeModel: string, requestBody: unknown) {
  const model = routeModel.toLowerCase();
  return hasReasoningRequest(requestBody) && (model.includes("kimi") || model.includes("moonshot"));
}

function cloneOpenAiStreamChunkWithDelta(chunk: Record<string, unknown>, delta: Record<string, unknown>, finishReason?: unknown) {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  return {
    ...chunk,
    choices: [
      {
        ...firstChoice,
        delta,
        finish_reason: finishReason ?? null
      },
      ...choices.slice(1)
    ]
  };
}

function openAiReasoningSegments(text: string, state: { inReasoning: boolean }) {
  const segments: Array<{ kind: "reasoning" | "content"; text: string }> = [];
  let rest = text;
  while (rest) {
    if (state.inReasoning) {
      const closeIndex = rest.indexOf("</think>");
      const rawReasoning = closeIndex >= 0 ? rest.slice(0, closeIndex) : rest;
      const reasoning = rawReasoning.replace(/<think>/g, "");
      if (reasoning) segments.push({ kind: "reasoning", text: reasoning });
      if (closeIndex < 0) break;
      state.inReasoning = false;
      rest = rest.slice(closeIndex + "</think>".length).replace(/^\s+/, "");
      continue;
    }

    const openIndex = rest.indexOf("<think>");
    if (openIndex < 0) {
      segments.push({ kind: "content", text: rest });
      break;
    }
    const content = rest.slice(0, openIndex);
    if (content) segments.push({ kind: "content", text: content });
    state.inReasoning = true;
    rest = rest.slice(openIndex + "<think>".length);
  }
  return segments;
}

async function* normalizeOpenAiChatReasoningStream(input: {
  stream: AsyncIterable<unknown>;
  routeModel: string;
  requestBody: unknown;
}) {
  const state = { inReasoning: shouldNormalizeReasoningContent(input.routeModel, input.requestBody) };
  for await (const chunk of input.stream) {
    if (!isRecord(chunk)) {
      yield chunk;
      continue;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    const delta = isRecord(choice?.delta) ? choice.delta : undefined;
    const content = typeof delta?.content === "string" ? delta.content : "";
    const hasNativeReasoning = Boolean(delta && (delta.reasoning || delta.reasoning_content));
    if (!choice || !delta || !content || hasNativeReasoning) {
      yield chunk;
      continue;
    }

    const shouldInspectTags = state.inReasoning || content.includes("<think>") || content.includes("</think>");
    if (!shouldInspectTags) {
      yield chunk;
      continue;
    }

    const { content: _content, ...restDelta } = delta;
    const segments = openAiReasoningSegments(content, state);
    if (segments.length === 0) continue;
    for (const [index, segment] of segments.entries()) {
      const segmentDelta =
        segment.kind === "reasoning"
          ? { ...restDelta, reasoning_content: segment.text }
          : { ...restDelta, content: segment.text };
      const finishReason = index === segments.length - 1 ? choice.finish_reason : null;
      yield cloneOpenAiStreamChunkWithDelta(chunk, segmentDelta, finishReason);
    }
  }
}

function serializeStreamEvent(proxyKind: ProxyKind, event: unknown) {
  if (proxyKind === "messages") {
    const eventName = isRecord(event) && typeof event.type === "string" ? event.type : "message_delta";
    return `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
  }
  if (proxyKind === "responses") {
    const eventName = isRecord(event) && typeof event.type === "string" ? event.type : "response.output_text.delta";
    return `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
  }
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function streamConvertedResponse(input: {
  upstreamBody: ReadableStream<Uint8Array>;
  response: http.ServerResponse;
  proxyKind: ProxyKind;
  routeEndpoint: RouteEndpointKind;
  routeModel: string;
  requestBody: unknown;
  converter: RosettaConverter;
}) {
  let preview = "";
  const upstreamStream =
    input.routeEndpoint === "chat/completions"
      ? normalizeOpenAiChatReasoningStream({
          stream: sseJsonObjectsFromReadable(input.upstreamBody),
          routeModel: input.routeModel,
          requestBody: input.requestBody
        })
      : sseJsonObjectsFromReadable(input.upstreamBody);
  for await (const event of input.converter.convertStream?.(upstreamStream) || []) {
    const chunk = serializeStreamEvent(input.proxyKind, event);
    preview += chunk;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    await writeResponseChunk(input.response, chunk);
  }
  if (input.proxyKind === "chat-completions" || input.proxyKind === "generic") {
    const done = "data: [DONE]\n\n";
    preview += done;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    await writeResponseChunk(input.response, done);
  }
  return preview;
}

async function streamRawResponse(input: {
  upstreamBody: ReadableStream<Uint8Array>;
  response: http.ServerResponse;
}) {
  let preview = "";
  for await (const chunk of textChunksFromReadable(input.upstreamBody)) {
    preview += chunk;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    await writeResponseChunk(input.response, chunk);
  }
  return preview;
}

function unsupportedProxyMessage() {
  return "代理入口支持 /proxy、/proxy/v1/messages、/proxy/v1/chat/completions、/proxy/v1/responses 和 /proxy/v1beta/models/{model}:generateContent";
}

function proxyKindLabel(kind: ProxyKind, pathname: string) {
  if (kind === "generic") return "proxy";
  if (kind === "messages") return "messages";
  if (kind === "chat-completions") return "chat/completions";
  if (kind === "responses") return "responses";
  if (kind === "gemini-generate") return "gemini:generateContent";
  if (kind === "gemini-stream") return "gemini:streamGenerateContent";
  return pathname;
}

function chainSummary(input: {
  downstreamModel?: string;
  downstreamEndpoint?: string;
  downstreamUa?: string;
  routeModel?: string;
  routeEndpoint?: string;
  routeUa?: string;
  status: RequestLogStatus;
}) {
  return `下游 ${input.downstreamModel || "unknown"} (${input.downstreamEndpoint || "unknown"} / ${input.downstreamUa || "unknown ua"}) -> 路由目标 ${input.routeModel || "unknown"} (${input.routeEndpoint || "unknown"} / ${input.routeUa || "unknown ua"}) -> ${input.status === "success" ? "成功" : "失败"}`;
}

function headerKey(headers: Record<string, string>, name: string) {
  return Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
}

function headerValue(headers: Record<string, string>, name: string) {
  const key = headerKey(headers, name);
  return key ? headers[key].trim() : "";
}

function setHeader(headers: Record<string, string>, name: string, value: string) {
  const existingKey = headerKey(headers, name);
  headers[existingKey || name] = value;
}

function looksLikeHtml(contentType: string | undefined, text: string) {
  const compact = text.trim().slice(0, 80).toLowerCase();
  return Boolean(contentType?.toLowerCase().includes("text/html") || compact.startsWith("<!doctype") || compact.startsWith("<html"));
}

function proxyEndpointCandidates(baseUrl: string, endpoint: string) {
  const candidates: string[] = [];
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!/\/v\d+$/i.test(pathname)) {
      candidates.push(joinUrl(baseUrl, `v1/${endpoint}`));
    }
  } catch {
    // Base URLs are validated before storage; keep the primary candidate if this ever fails.
  }
  candidates.push(joinUrl(baseUrl, endpoint));
  return Array.from(new Set(candidates));
}

function modelEndpointCandidates(baseUrl: string) {
  const candidates: string[] = [];
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!/\/v\d+$/i.test(pathname)) {
      candidates.push(joinUrl(baseUrl, "v1/models"));
    }
  } catch {
    // Base URLs are validated before storage; keep the primary candidate if this ever fails.
  }
  candidates.push(joinUrl(baseUrl, "models"));
  return Array.from(new Set(candidates));
}

function newApiPricingEndpointCandidates(baseUrl: string) {
  const candidates: string[] = [];
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (/\/v\d+$/i.test(pathname)) {
      parsed.pathname = pathname.replace(/\/v\d+$/i, "");
      candidates.push(joinUrl(parsed.toString(), "api/pricing"));
    }
  } catch {
    // Base URLs are validated before storage; keep the regular candidate if this ever fails.
  }
  candidates.push(joinUrl(baseUrl, "api/pricing"));
  return Array.from(new Set(candidates));
}

function newApiPricingHeaders(target: string) {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-store"
  };
  try {
    const parsed = new URL(target);
    headers.Referer = `${parsed.origin}/pricing`;
  } catch {
    // Keep the generic headers if URL parsing ever fails.
  }
  return headers;
}

function parseModelList(payload: unknown) {
  const source =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data?: unknown }).data
      : payload && typeof payload === "object" && "models" in payload
        ? (payload as { models?: unknown }).models
        : payload;
  if (!Array.isArray(source)) return [];
  return Array.from(
    new Set(
      source
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "id" in item) return String((item as { id?: unknown }).id || "");
          if (item && typeof item === "object" && "name" in item) return String((item as { name?: unknown }).name || "");
          return "";
        })
        .map((model) => model.trim())
        .filter(Boolean)
    )
  ).sort();
}

function parseNewApiPriceModels(payload: unknown, apiKeyName: string) {
  const source =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data?: unknown }).data
      : payload;
  if (!Array.isArray(source)) return [];
  return Array.from(
    new Set(
      source
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          const groups = "enable_groups" in item ? (item as { enable_groups?: unknown }).enable_groups : [];
          if (!Array.isArray(groups) || !groups.some((group) => group === apiKeyName)) return "";
          const modelName = "model_name" in item ? (item as { model_name?: unknown }).model_name : undefined;
          return typeof modelName === "string" ? modelName.trim() : "";
        })
        .filter(Boolean)
    )
  ).sort();
}

function recordModelDiscoveryLog(input: {
  request: http.IncomingMessage;
  siteId: string;
  site?: Site;
  address?: SiteAddress;
  target?: string;
  apiKeyValue: string;
  apiKeyName?: string;
  discoveryType?: string;
  status: "success" | "failed";
  statusCode: number;
  startedAt: number;
  contentType?: string;
  responseText?: string;
  models?: string[];
  errorMessage?: string;
  usesApiKey?: boolean;
}) {
  const maskedApiKey = maskSecret(input.apiKeyValue);
  const responsePreviewText =
    input.responseText ||
    (input.models
      ? JSON.stringify({ modelCount: input.models.length, models: input.models.slice(0, 80) }, null, 2)
      : undefined);

  store.recordRequestLog({
    routeName: "获取模型",
    method: input.request.method || "POST",
    path: "/api/provider-key-groups/discover-models",
    providerName: input.site?.name || "未选择供应商",
    providerId: input.site?.id,
    addressLabel: input.address?.label,
    model: input.models ? `模型发现：${input.models.length} 个模型` : "模型发现",
    userAgent: valueToHeaderText(input.request.headers["user-agent"]),
    clientIp: input.request.socket.remoteAddress || "",
    status: input.status,
    statusCode: input.statusCode,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    requestHeaders: {
      ...maskRequestHeaders(input.request.headers),
      "upstream-accept": "application/json",
      ...(input.usesApiKey !== false && maskedApiKey ? { "upstream-authorization": `Bearer ${maskedApiKey}` } : {})
    },
    requestBody: {
      siteId: input.siteId || undefined,
      siteName: input.site?.name,
      siteType: input.site?.siteType || "unknown",
      discoveryType: input.discoveryType || "openai-models",
      addressId: input.address?.id,
      addressLabel: input.address?.label,
      target: input.target,
      apiKeyName: input.apiKeyName,
      apiKey: maskedApiKey || undefined
    },
    upstreamUrl: input.target,
    upstreamContentType: input.contentType,
    responsePreview: responsePreviewText ? responsePreview(responsePreviewText) : undefined,
    errorMessage: input.errorMessage
  });
}

async function discoverProviderModels(siteId: string, apiKey: string, apiKeyName: string, request: http.IncomingMessage) {
  const discoveryStartedAt = Date.now();
  const apiKeyValue = apiKey.trim();
  const apiKeyNameValue = apiKeyName.trim();
  if (!siteId) {
    recordModelDiscoveryLog({
      request,
      siteId,
      apiKeyValue,
      apiKeyName: apiKeyNameValue,
      status: "failed",
      statusCode: 400,
      startedAt: discoveryStartedAt,
      errorMessage: "请选择供应商"
    });
    throw new Error("请选择供应商");
  }
  const maskedApiKey = maskSecret(apiKeyValue);
  const site = store.getDb().sites.find((item) => item.id === siteId);
  if (!apiKeyValue) {
    recordModelDiscoveryLog({
      request,
      siteId,
      site,
      apiKeyValue,
      apiKeyName: apiKeyNameValue,
      status: "failed",
      statusCode: 400,
      startedAt: discoveryStartedAt,
      errorMessage: "API Key 不能为空"
    });
    throw new Error("API Key 不能为空");
  }
  if (!site) {
    recordModelDiscoveryLog({
      request,
      siteId,
      apiKeyValue,
      apiKeyName: apiKeyNameValue,
      status: "failed",
      statusCode: 400,
      startedAt: discoveryStartedAt,
      errorMessage: "供应商不存在"
    });
    throw new Error("供应商不存在");
  }
  const discoveryType = site.siteType === "newapi" ? "newapi-pricing" : "openai-models";
  if (site.siteType === "newapi" && !apiKeyNameValue) {
    recordModelDiscoveryLog({
      request,
      siteId,
      site,
      apiKeyValue,
      apiKeyName: apiKeyNameValue,
      discoveryType,
      status: "failed",
      statusCode: 400,
      startedAt: discoveryStartedAt,
      errorMessage: "NewApi 获取模型需要填写 API Key 名称，用于匹配 enable_groups"
    });
    throw new Error("NewApi 获取模型需要填写 API Key 名称，用于匹配 enable_groups");
  }
  const addresses = site.addresses.filter((item) => item.enabled);
  const candidates = addresses.length > 0 ? addresses : site.addresses;
  if (candidates.length === 0) {
    recordModelDiscoveryLog({
      request,
      siteId,
      site,
      apiKeyValue,
      apiKeyName: apiKeyNameValue,
      discoveryType,
      status: "failed",
      statusCode: 400,
      startedAt: discoveryStartedAt,
      errorMessage: "供应商地址不可用"
    });
    throw new Error("供应商地址不可用");
  }

  const errors: string[] = [];
  for (const address of candidates) {
    const targets =
      site.siteType === "newapi"
        ? [
            ...newApiPricingEndpointCandidates(address.baseUrl).map((target) => ({
              target,
              discoveryType: "newapi-pricing",
              usesApiKey: false
            })),
            ...modelEndpointCandidates(address.baseUrl).map((target) => ({
              target,
              discoveryType: "openai-models",
              usesApiKey: true
            }))
          ]
        : modelEndpointCandidates(address.baseUrl).map((target) => ({
            target,
            discoveryType: "openai-models",
            usesApiKey: true
          }));
    for (const targetEntry of targets) {
      const { target } = targetEntry;
      const attemptStartedAt = Date.now();
      try {
        const upstream = await fetch(target, {
          headers: targetEntry.usesApiKey
            ? {
                Authorization: `Bearer ${apiKeyValue}`,
                Accept: "application/json"
              }
            : newApiPricingHeaders(target)
        });
        const contentType = upstream.headers.get("content-type") || "";
        const text = await upstream.text();
        if (!upstream.ok) {
          const authHint =
            targetEntry.usesApiKey && [401, 403].includes(upstream.status)
              ? `（已携带 Authorization: Bearer ${maskedApiKey}）`
              : "";
          const upstreamMessage = extractUpstreamError(text);
          const errorMessage = `${upstream.status}${authHint}${upstreamMessage ? ` ${upstreamMessage}` : ""}`;
          errors.push(`${address.label} ${target}：${errorMessage}`);
          recordModelDiscoveryLog({
            request,
            siteId,
            site,
            address,
            target,
            apiKeyValue,
            apiKeyName: apiKeyNameValue,
            discoveryType: targetEntry.discoveryType,
            status: "failed",
            statusCode: upstream.status,
            startedAt: attemptStartedAt,
            contentType,
            responseText: text,
            errorMessage,
            usesApiKey: targetEntry.usesApiKey
          });
          continue;
        }
        const preview = compactPreview(text);
        if (text && !contentType.includes("application/json") && /^\s*</.test(text)) {
          const errorMessage = "返回了 HTML 页面，请检查站点地址是否为 API Base URL";
          errors.push(`${address.label} ${target}：${errorMessage}`);
          recordModelDiscoveryLog({
            request,
            siteId,
            site,
            address,
            target,
            apiKeyValue,
            apiKeyName: apiKeyNameValue,
            discoveryType: targetEntry.discoveryType,
            status: "failed",
            statusCode: upstream.status,
            startedAt: attemptStartedAt,
            contentType,
            responseText: text,
            errorMessage,
            usesApiKey: targetEntry.usesApiKey
          });
          continue;
        }
        let payload: unknown = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          const errorMessage = `返回内容不是合法 JSON${preview ? `（${preview}` : ""}${preview ? "）" : ""}`;
          errors.push(`${address.label} ${target}：${errorMessage}`);
          recordModelDiscoveryLog({
            request,
            siteId,
            site,
            address,
            target,
            apiKeyValue,
            apiKeyName: apiKeyNameValue,
            discoveryType: targetEntry.discoveryType,
            status: "failed",
            statusCode: upstream.status,
            startedAt: attemptStartedAt,
            contentType,
            responseText: text,
            errorMessage,
            usesApiKey: targetEntry.usesApiKey
          });
          continue;
        }
        const models = parseModelList(payload);
        const resolvedModels =
          targetEntry.discoveryType === "newapi-pricing"
            ? parseNewApiPriceModels(payload, apiKeyNameValue)
            : models;
        if (resolvedModels.length === 0) {
          const errorMessage =
            targetEntry.discoveryType === "newapi-pricing"
              ? `未在 enable_groups 中匹配到 API Key 名称「${apiKeyNameValue}」的可用模型`
              : "未解析到模型列表";
          errors.push(`${address.label} ${target}：${errorMessage}`);
          recordModelDiscoveryLog({
            request,
            siteId,
            site,
            address,
            target,
            apiKeyValue,
            apiKeyName: apiKeyNameValue,
            discoveryType: targetEntry.discoveryType,
            status: "failed",
            statusCode: upstream.status,
            startedAt: attemptStartedAt,
            contentType,
            responseText: text,
            errorMessage,
            usesApiKey: targetEntry.usesApiKey
          });
          continue;
        }
        recordModelDiscoveryLog({
          request,
          siteId,
          site,
          address,
          target,
          apiKeyValue,
          apiKeyName: apiKeyNameValue,
          discoveryType: targetEntry.discoveryType,
          status: "success",
          statusCode: upstream.status,
          startedAt: attemptStartedAt,
          contentType,
          responseText: text,
          models: resolvedModels,
          usesApiKey: targetEntry.usesApiKey
        });
        return { siteId, siteName: site.name, addressId: address.id, addressLabel: address.label, models: resolvedModels };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "请求失败";
        errors.push(`${address.label} ${target}：${errorMessage}`);
        recordModelDiscoveryLog({
          request,
          siteId,
          site,
          address,
          target,
          apiKeyValue,
          apiKeyName: apiKeyNameValue,
          discoveryType: targetEntry.discoveryType,
          status: "failed",
          statusCode: 599,
          startedAt: attemptStartedAt,
          errorMessage,
          usesApiKey: targetEntry.usesApiKey
        });
      }
    }
  }

  throw new Error(`模型列表获取失败：${errors.slice(0, 4).join("；") || "没有可用地址"}`);
}

function resolveLogContext(routeNameOrId: string): Partial<RequestLog> {
  try {
    const resolved = store.resolveRoute(routeNameOrId);
    const firstAddress = resolved.addresses[0];
    return {
      routeId: resolved.route.id,
      routeName: resolved.route.name,
      endpoint: resolved.route.endpoint,
      providerName: resolved.site.name,
      providerId: resolved.site.id,
      addressLabel: firstAddress?.label,
      model: resolved.route.model,
      upstreamUrl: firstAddress ? joinUrl(firstAddress.baseUrl, resolved.route.endpoint) : undefined
    };
  } catch {
    return {};
  }
}

async function handleApi(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method || "GET";

  if (method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  try {
    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, dataDir: store.dataDir, dbPath: store.dbPath });
      return;
    }

    if (method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(response, 200, store.snapshot());
      return;
    }

    if (parts[1] === "settings") {
      if (method === "PATCH") return sendJson(response, 200, store.updateSettings(await readJson(request)));
    }

    if (parts[1] === "logs") {
      if (method === "GET") return sendJson(response, 200, store.listRequestLogs());
      if (method === "DELETE" && parts[2] === "clear") {
        store.clearRequestLogs();
        return sendJson(response, 200, { ok: true });
      }
      if (method === "DELETE") {
        store.deleteRequestLog(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "sites") {
      if (method === "GET") return sendJson(response, 200, store.getDb().sites);
      if (method === "POST") return sendJson(response, 201, store.upsertSite(await readJson(request)));
      if (method === "PATCH") return sendJson(response, 200, store.upsertSite({ ...(await readJson(request)), id: routeParam(parts, 2) }));
      if (method === "DELETE") {
        store.deleteSite(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "keys") {
      if (method === "GET") return sendJson(response, 200, store.getDb().apiKeys);
      if (method === "POST") {
        const body = await readJson(request);
        return sendJson(response, 201, store.createApiKey(String(body.name || "")));
      }
      if (method === "PATCH") return sendJson(response, 200, store.updateApiKey(routeParam(parts, 2), await readJson(request)));
      if (method === "DELETE") {
        store.deleteApiKey(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "provider-key-groups") {
      if (method === "POST" && parts[2] === "discover-models") {
        const body = await readJson(request);
        return sendJson(
          response,
          200,
          await discoverProviderModels(String(body.siteId || ""), String(body.apiKey || ""), String(body.apiKeyName || ""), request)
        );
      }
      if (method === "GET") return sendJson(response, 200, store.snapshot().providerApiKeyGroups);
      if (method === "POST") return sendJson(response, 201, store.upsertProviderApiKeyGroup(await readJson(request)));
      if (method === "DELETE") {
        store.deleteProviderApiKeyGroup(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "headers") {
      if (method === "GET") return sendJson(response, 200, store.getDb().headerTemplates);
      if (method === "POST") return sendJson(response, 201, store.upsertHeaderTemplate(await readJson(request)));
      if (method === "PATCH") return sendJson(response, 200, store.upsertHeaderTemplate({ ...(await readJson(request)), id: routeParam(parts, 2) }));
      if (method === "DELETE") {
        store.deleteHeaderTemplate(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    if (parts[1] === "routes") {
      if (method === "GET") return sendJson(response, 200, store.getDb().routes);
      if (method === "POST") return sendJson(response, 201, store.upsertSwitchRoute(await readJson(request)));
      if (method === "PATCH") return sendJson(response, 200, store.upsertSwitchRoute({ ...(await readJson(request)), id: routeParam(parts, 2) }));
      if (method === "DELETE") {
        store.deleteRoute(routeParam(parts, 2));
        return sendJson(response, 200, { ok: true });
      }
    }

    notFound(response);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request" });
  }
}

async function handleProxy(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const startedAt = Date.now();
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
    routeName: routeNameOrId || "unknown"
  };
  const downstreamLog = {
    model: routeNameOrId || requestModelName(body) || "unknown",
    endpoint: downstreamEndpoint,
    userAgent: downstreamUa,
    path: url.pathname,
    method: request.method || "POST"
  };

  const apiKey = request.headers.authorization || request.headers["x-api-key"] || url.searchParams.get("key") || undefined;
  if (!store.verifyApiKey(Array.isArray(apiKey) ? apiKey[0] : apiKey)) {
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

  try {
    if (!routeNameOrId) throw new Error("请求体中的 model 必须填写路由名称");
    const { route, site, addresses, headerTemplate } = store.resolveRoute(routeNameOrId);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...parseHeaderTemplate(headerTemplate?.headersText)
    };
    const providerApiKey = store.resolveProviderApiKey(site.id, route.model);
    if (!providerApiKey && !headerValue(headers, "Authorization")) throw new Error(`未找到支持模型 ${route.model} 的上游 API Key`);
    if (providerApiKey) setHeader(headers, "Authorization", `Bearer ${providerApiKey.secret}`);
    const routeUa = headerValue(headers, "User-Agent") || "fetch default";
    const routeTargetLog = {
      routeName: route.name,
      model: route.model,
      endpoint: route.endpoint,
      providerName: site.name,
      userAgent: routeUa
    };
    const upstreamAuthLog: Record<string, string> = providerApiKey
      ? {
          "upstream-api-key": providerApiKey.label,
          "upstream-authorization": `Bearer ${maskSecret(providerApiKey.secret)}`
        }
      : {
          "upstream-authorization": "Header 模版已提供"
        };
    const downstreamStream = isStreamingRequest(body) || proxyInfo.kind === "gemini-stream";
    const converted = convertedRouteRequestBody(body, route.model, route.endpoint, proxyInfo.kind);
    const responseConverter = converted.converter;
    const forwardedBody = downstreamStream ? applyStreamingFlag(converted.body, true) : converted.body;
    const upstreamRequestHeaders = {
      ...maskedStringHeaders(headers),
      ...upstreamAuthLog
    };

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
    const upstreamAttempts: NonNullable<RequestLog["upstreamAttempts"]> = [];

    for (const address of addresses) {
      for (const target of proxyEndpointCandidates(address.baseUrl, route.endpoint)) {
        const attemptStartedAt = Date.now();
        try {
          const upstream = await fetch(target, {
            method: request.method || "POST",
            headers,
            body: JSON.stringify(forwardedBody)
          });
          const contentType = upstream.headers.get("content-type") || undefined;

          if (upstream.ok && !looksLikeHtml(contentType, "")) {
            if (downstreamStream && upstream.body) {
              response.writeHead(upstream.status, {
                "Content-Type": streamResponseContentType(proxyInfo.kind, contentType),
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*"
              });
              try {
                const streamPreviewText =
                  responseConverter?.convertStream
                    ? await streamConvertedResponse({
                        upstreamBody: upstream.body,
                        response,
                        proxyKind: proxyInfo.kind,
                        routeEndpoint: route.endpoint,
                        routeModel: route.model,
                        requestBody: forwardedBody,
                        converter: responseConverter
                      })
                    : await streamRawResponse({ upstreamBody: upstream.body, response });
                response.end();
                upstreamAttempts.push({
                  addressLabel: address.label,
                  upstreamUrl: target,
                  method: request.method || "POST",
                  model: route.model,
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
                store.recordRequestLog({
                  ...requestLogBase,
                  routeId: route.id,
                  routeName: route.name,
                  endpoint: route.endpoint,
                  providerName: site.name,
                  providerId: site.id,
                  addressLabel: address.label,
                  model: route.model,
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
                  summary: chainSummary({
                    downstreamModel: downstreamLog.model,
                    downstreamEndpoint,
                    downstreamUa,
                    routeModel: route.model,
                    routeEndpoint: route.endpoint,
                    routeUa,
                    status: "success"
                  })
                });
                return;
              } catch (streamError) {
                const errorMessage = streamError instanceof Error ? streamError.message : "流式转发失败";
                upstreamAttempts.push({
                  addressLabel: address.label,
                  upstreamUrl: target,
                  method: request.method || "POST",
                  model: route.model,
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
                store.recordRequestLog({
                  ...requestLogBase,
                  routeId: route.id,
                  routeName: route.name,
                  endpoint: route.endpoint,
                  providerName: site.name,
                  providerId: site.id,
                  addressLabel: address.label,
                  model: route.model,
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
                  summary: chainSummary({
                    downstreamModel: downstreamLog.model,
                    downstreamEndpoint,
                    downstreamUa,
                    routeModel: route.model,
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
                model: route.model,
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
              model: route.model,
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
              providerName: site.name,
              providerId: site.id,
              addressLabel: address.label,
              model: route.model,
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
              summary: chainSummary({
                downstreamModel: downstreamLog.model,
                downstreamEndpoint,
                downstreamUa,
                routeModel: route.model,
                routeEndpoint: route.endpoint,
                routeUa,
                status: "success"
              })
            });
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
          errors.push(`${address.label} ${target}：${upstream.status} ${errorMessage}`);
          upstreamAttempts.push({
            addressLabel: address.label,
            upstreamUrl: target,
            method: request.method || "POST",
            model: route.model,
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
          const errorMessage = error instanceof Error ? error.message : "请求上游失败";
          errors.push(`${address.label} ${target}：${errorMessage}`);
          upstreamAttempts.push({
            addressLabel: address.label,
            upstreamUrl: target,
            method: request.method || "POST",
            model: route.model,
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

    const message = `上游地址均不可用：${errors.join("；") || "没有可用地址"}`;
    const failedAddress = lastFailure?.address || addresses[0];
    store.recordRequestLog({
      ...requestLogBase,
      routeId: route.id,
      routeName: route.name,
      endpoint: route.endpoint,
      providerName: site.name,
      providerId: site.id,
      addressLabel: failedAddress?.label,
      model: route.model,
      requestBody: body,
      status: "failed",
      statusCode: lastFailure?.statusCode || 502,
      durationMs: Date.now() - startedAt,
      requestHeaders: {
        ...requestLogBase.requestHeaders,
        ...upstreamAuthLog
      },
      upstreamUrl: lastFailure?.target,
      upstreamContentType: lastFailure?.contentType,
      responsePreview: lastFailure?.text ? responsePreview(lastFailure.text) : undefined,
      errorMessage: message,
      downstream: downstreamLog,
      routeTarget: routeTargetLog,
      upstreamAttempts,
      summary: chainSummary({
        downstreamModel: downstreamLog.model,
        downstreamEndpoint,
        downstreamUa,
        routeModel: route.model,
        routeEndpoint: route.endpoint,
        routeUa,
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
    const message = error instanceof Error ? error.message : "Proxy failed";
    store.recordRequestLog({
      ...requestLogBase,
      ...routeLogContext,
      requestBody: body,
      status: "failed",
      statusCode: 502,
      durationMs: Date.now() - startedAt,
      errorMessage: message
    });
    sendJson(response, 502, { error: message });
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }
  if (isSupportedProxyPath(url.pathname)) {
    await handleProxy(request, response, url);
    return;
  }
  if (url.pathname.startsWith("/proxy/")) {
    await handleUnsupportedProxyPath(request, response, url);
    return;
  }
  notFound(response);
});

server.listen(PORT, HOST, () => {
  console.log(`SamAPI API is running at http://${HOST}:${PORT}`);
  console.log(`Local access: http://127.0.0.1:${PORT}`);
  console.log(`Database: ${store.dbPath}`);
});
