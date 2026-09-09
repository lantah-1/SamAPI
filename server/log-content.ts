import { isRecord } from "./util/text.js";

const configuredLimit = Number(process.env.SAMAPI_LOG_BODY_MAX_CHARS || 20000);
export const LOG_RESULT_MAX_CHARS = Number.isFinite(configuredLimit)
  ? Math.min(1_000_000, Math.max(1000, Math.floor(configuredLimit)))
  : 20000;
const TRUNCATED = "\n…（内容已截断）";

export function limitLogText(text: string, limit = LOG_RESULT_MAX_CHARS) {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - TRUNCATED.length))}${TRUNCATED}` : text;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part): string => {
    if (typeof part === "string") return part;
    if (!isRecord(part) || part.type === "tool_result" || part.functionResponse) return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.refusal === "string") return part.refusal;
    if (["image", "image_url", "input_image"].includes(String(part.type)) || part.inlineData) return "[图片内容已省略]";
    if (["file", "input_file"].includes(String(part.type)) || part.fileData) return `[文件：${String(part.filename || part.name || "附件")}，内容已省略]`;
    if (["audio", "input_audio"].includes(String(part.type))) return "[音频内容已省略]";
    return "";
  }).filter(Boolean).join("\n");
}

/** Keep user turns in order, including repeated turns; omit system prompts, tool results and assistant history. */
export function userMessages(body: unknown): string[] {
  if (!isRecord(body)) return [];
  if (body.truncated === true && typeof body.preview === "string") {
    try {
      return userMessages(JSON.parse(body.preview));
    } catch {
      return ["[旧日志的请求体已截断，无法恢复完整用户消息]"];
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : Array.isArray(body.contents) ? body.contents
    : undefined;
  if (messages) {
    return messages.flatMap((message) => {
      if (!isRecord(message)) return [];
      if (message.role !== "user" && !(message.role === undefined && (message.type === "message" || Array.isArray(message.parts)))) return [];
      const text = contentText(message.content ?? message.parts);
      return text ? [text] : [];
    });
  }
  const text = typeof body.input === "string" ? body.input
    : typeof body.msg === "string" ? body.msg
    : typeof body.prompt === "string" ? body.prompt : "";
  return text ? [text] : [];
}

function toolText(tool: unknown): string {
  if (!isRecord(tool)) return "";
  const fn = isRecord(tool.function) ? tool.function : tool;
  if (typeof fn.name !== "string") return "";
  const args = fn.arguments ?? fn.input ?? fn.args;
  return `[工具调用 ${fn.name}]${args === undefined ? "" : `\n${typeof args === "string" ? args : JSON.stringify(args)}`}`;
}

function outputText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return "";
  if (isRecord(payload.error)) return String(payload.error.message || JSON.stringify(payload.error));
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.choices)) {
    return payload.choices.map((choice) => {
      if (!isRecord(choice)) return "";
      const message = isRecord(choice.message) ? choice.message : {};
      const tools = Array.isArray(message.tool_calls) ? message.tool_calls.map(toolText).filter(Boolean) : [];
      return [contentText(message.content), typeof choice.text === "string" ? choice.text : "", ...tools].filter(Boolean).join("\n");
    }).filter(Boolean).join("\n");
  }
  if (Array.isArray(payload.output)) {
    return payload.output.map((item) => {
      if (!isRecord(item)) return "";
      return item.type === "function_call" || item.type === "custom_tool_call" ? toolText(item) : contentText(item.content);
    }).filter(Boolean).join("\n");
  }
  if (Array.isArray(payload.content)) {
    return payload.content.map((part) => isRecord(part) && part.type === "tool_use" ? toolText(part) : contentText([part])).filter(Boolean).join("\n");
  }
  if (Array.isArray(payload.candidates)) {
    return payload.candidates.map((candidate) => {
      if (!isRecord(candidate) || !isRecord(candidate.content)) return "";
      const parts = Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
      return parts.map((part) => isRecord(part) && part.functionCall ? toolText(part.functionCall) : contentText([part])).filter(Boolean).join("\n");
    }).filter(Boolean).join("\n");
  }
  return "";
}

function jsonFallback(value: unknown) {
  return JSON.stringify(value, (key, item: unknown) => {
    if (typeof item === "string" && (/^data:[^,]*;base64,/i.test(item) || key === "b64_json" || (key === "data" && item.length > 1024))) {
      return "[二进制内容已省略]";
    }
    return item;
  }) || "";
}

export function responseLogText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    if (/^(?:event:|data:\s*(?:\{|\[DONE\]))/.test(value.trimStart())) {
      const collector = createStreamLogCollector();
      collector.push(value);
      return collector.finish() || limitLogText(value);
    }
    try {
      const parsed: unknown = JSON.parse(value);
      return limitLogText(outputText(parsed) || jsonFallback(parsed));
    } catch {
      return limitLogText(value);
    }
  }
  return limitLogText(outputText(value) || jsonFallback(value));
}

/** Bounded capture of reply content, independent of the SSE chunks sent to the client. */
export function createStreamLogCollector(onEvent?: (value: unknown) => void) {
  let deltas = "";
  let completed = "";
  let error = "";
  let buffer = "";
  let skippingFrame = false;
  const maxFrameChars = Math.max(65536, LOG_RESULT_MAX_CHARS * 4);
  const append = (text: string) => { deltas = limitLogText(deltas + text); };

  const event = (value: unknown) => {
    if (!isRecord(value)) return;
    onEvent?.(value);
    const type = String(value.type || "");
    if (type === "error" || type.endsWith(".failed") || value.error) {
      const detail = value.error || (isRecord(value.response) ? value.response.error : undefined);
      error = responseLogText(detail || value.message || "上游返回错误");
    }
    if (type === "response.output_text.delta" || type === "response.refusal.delta" || type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
      if (typeof value.delta === "string") append(value.delta);
    } else if (type === "content_block_delta" && isRecord(value.delta)) {
      if (typeof value.delta.text === "string") append(value.delta.text);
      else if (typeof value.delta.partial_json === "string") append(value.delta.partial_json);
    } else if (type === "content_block_start" && isRecord(value.content_block)) {
      const part = value.content_block;
      if (part.type === "tool_use") append(`[工具调用 ${String(part.name || "unknown")}]\n`);
      else if (typeof part.text === "string") append(part.text);
    } else if (type === "response.output_item.added" && isRecord(value.item) && ["function_call", "custom_tool_call"].includes(String(value.item.type))) {
      append(`[工具调用 ${String(value.item.name || "unknown")}]\n`);
    } else if (Array.isArray(value.choices)) {
      for (const choice of value.choices) {
        if (!isRecord(choice)) continue;
        if (isRecord(choice.delta)) {
          append(contentText(choice.delta.content));
          if (Array.isArray(choice.delta.tool_calls)) for (const call of choice.delta.tool_calls) {
            if (!isRecord(call) || !isRecord(call.function)) continue;
            if (typeof call.function.name === "string") append(`[工具调用 ${call.function.name}]\n`);
            if (typeof call.function.arguments === "string") append(call.function.arguments);
          }
        } else if (choice.message) completed = limitLogText(outputText(value));
      }
    } else if (Array.isArray(value.candidates)) {
      append(outputText(value));
    } else if (["response.completed", "response.incomplete"].includes(type) && isRecord(value.response)) {
      completed = limitLogText(outputText(value.response));
    } else if (!type || type === "message") {
      completed = limitLogText(outputText(value));
    }
  };

  const frame = (text: string) => {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    try { event(JSON.parse(data)); } catch { /* A partial legacy preview may end inside an event. */ }
  };

  const push = (chunk: string) => {
    buffer += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const text = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (!skippingFrame) frame(text);
      skippingFrame = false;
    }
    if (buffer.length > maxFrameChars) {
      buffer = buffer.slice(-3);
      skippingFrame = true;
    }
  };

  return {
    event,
    push,
    get error() { return error; },
    snapshot() { return limitLogText(completed || deltas || error); },
    finish() {
      if (buffer && !skippingFrame) {
        if (/^(?:event:|data:)/m.test(buffer)) frame(buffer);
        else {
          try { const parsed: unknown = JSON.parse(buffer); event(parsed); completed = responseLogText(parsed); } catch { /* Incomplete frame. */ }
        }
      }
      buffer = "";
      return limitLogText(completed || deltas || error);
    }
  };
}
