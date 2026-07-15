import http from "node:http";
import { bodyRecord, extractUpstreamError, isRecord } from "../util/text.js";
import { extractResponseText } from "./payload.js";
import type { ProxyKind, RosettaConverter, RouteEndpointKind } from "../proxy-path.js";

export function adaptResponseText(text: string, contentType: string | undefined, proxyKind: ProxyKind) {
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

export function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function anthropicMessageToSse(message: unknown) {
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

export function convertUpstreamResponseText(input: {
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

export function streamResponseContentType(proxyKind: ProxyKind, contentType?: string) {
  if (proxyKind === "messages" || proxyKind === "chat-completions" || proxyKind === "responses" || proxyKind === "generic") {
    return "text/event-stream; charset=utf-8";
  }
  return contentType || "text/event-stream; charset=utf-8";
}

export async function writeResponseChunk(response: http.ServerResponse, chunk: string | Uint8Array) {
  if (response.destroyed || response.writableEnded) throw new Error("客户端已断开连接");
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("客户端已断开连接"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

export async function* textChunksFromReadable(stream: ReadableStream<Uint8Array>) {
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

export function parseSseFrame(frame: string) {
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

export async function* sseJsonObjectsFromReadable(stream: ReadableStream<Uint8Array>) {
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

export function hasReasoningRequest(body: unknown) {
  const source = bodyRecord(body);
  return Boolean(source.reasoning_effort || source.reasoning || source.thinking);
}

export function shouldNormalizeReasoningContent(routeModel: string, requestBody: unknown) {
  const model = routeModel.toLowerCase();
  return hasReasoningRequest(requestBody) && (model.includes("kimi") || model.includes("moonshot"));
}

export function cloneOpenAiStreamChunkWithDelta(chunk: Record<string, unknown>, delta: Record<string, unknown>, finishReason?: unknown) {
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

export function openAiReasoningSegments(text: string, state: { inReasoning: boolean }) {
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

export async function* normalizeOpenAiChatReasoningStream(input: {
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

export function serializeStreamEvent(proxyKind: ProxyKind, event: unknown) {
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

export function streamEventErrorMessage(event: unknown) {
  if (!isRecord(event)) return "";
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const error = event.error;
  const errorRecord = isRecord(error) ? error : undefined;
  const message =
    (typeof errorRecord?.message === "string" && errorRecord.message) ||
    (typeof error === "string" && error) ||
    (typeof event.message === "string" && event.message) ||
    "";
  if (type === "error" || type.includes(".error") || type.endsWith(".failed") || errorRecord) {
    return message || JSON.stringify(event);
  }
  return "";
}

export function streamPreviewErrorMessage(preview: string) {
  if (!/(^|\n)event:\s*error\b|"type"\s*:\s*"(?:error|response\.failed)"/i.test(preview)) return "";
  return extractUpstreamError(preview) || "上游流返回错误事件";
}

export async function streamConvertedResponse(input: {
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
    const errorMessage = streamEventErrorMessage(event);
    if (errorMessage) throw new Error(errorMessage);
  }
  if (input.proxyKind === "chat-completions" || input.proxyKind === "generic") {
    const done = "data: [DONE]\n\n";
    preview += done;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    await writeResponseChunk(input.response, done);
  }
  return preview;
}

export async function streamRawResponse(input: {
  upstreamBody: ReadableStream<Uint8Array>;
  response: http.ServerResponse;
}) {
  let preview = "";
  for await (const chunk of textChunksFromReadable(input.upstreamBody)) {
    preview += chunk;
    if (preview.length > 1200) preview = preview.slice(0, 1200);
    await writeResponseChunk(input.response, chunk);
  }
  const errorMessage = streamPreviewErrorMessage(preview);
  if (errorMessage) throw new Error(errorMessage);
  return preview;
}
