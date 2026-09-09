import { parseSseFrame, streamEventErrorMessage } from "./convert/stream.js";
import { StreamPreludeBuffer } from "./stream-prelude-buffer.js";
import { isRecord, looksLikeHtml } from "./util/text.js";

const streamHeartbeats = new Set(["ping", "keepalive", "keep-alive", "keep_alive", "heartbeat"]);

function hasStreamContent(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.some(hasStreamContent);
  if (isRecord(value)) {
    if (["text", "output_text", "summary_text", "reasoning_text"].includes(String(value.type))) return hasStreamContent(value.text);
    if (value.type === "refusal") return hasStreamContent(value.refusal);
    if (value.type === "thinking") return hasStreamContent(value.thinking);
  }
  // Preserve unfamiliar content (e.g. image output) rather than treating it as empty.
  return true;
}

function isOutputItemPrelude(item: unknown) {
  if (item == null) return true;
  if (!isRecord(item)) return false;
  if (item.type === "message") return !hasStreamContent(item.content);
  if (item.type === "reasoning") {
    // Responses Lite omits empty fields or sends null. IDs, status and encrypted
    // reasoning state do not establish that any reply content has been produced.
    return !hasStreamContent(item.summary) && !hasStreamContent(item.content);
  }
  return false;
}

function isStreamPrelude(value: unknown, eventName: string) {
  const type = isRecord(value) && typeof value.type === "string" ? value.type : eventName;
  // Codex keepalives can be data-bearing SSE events, not just comments. They must
  // not commit the downstream response and take a later overload out of the retry loop.
  if (streamHeartbeats.has(type)) return true;
  if (!isRecord(value)) return false;
  // Codex relays send quota/header metadata before generation; it must not commit the downstream stream.
  if (["codex.rate_limits", "codex.response.metadata"].includes(type)) return true;
  if (["response.created", "response.queued", "response.in_progress"].includes(type)) {
    return !(isRecord(value.response) && Array.isArray(value.response.output) && value.response.output.some((item) => !isOutputItemPrelude(item)));
  }
  if (type === "message_start") return !(isRecord(value.message) && hasStreamContent(value.message.content));
  if (["response.output_item.added", "response.output_item.done"].includes(type)) return isOutputItemPrelude(value.item);
  if (["response.content_part.added", "response.content_part.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done"].includes(type)) {
    return !hasStreamContent(value.part);
  }
  if (["response.output_text.delta", "response.reasoning_summary_text.delta", "response.reasoning_text.delta", "response.refusal.delta"].includes(type)) {
    return !hasStreamContent(value.delta);
  }
  if (["response.output_text.done", "response.reasoning_summary_text.done", "response.reasoning_text.done"].includes(type)) return !hasStreamContent(value.text);
  if (type === "response.refusal.done") return !hasStreamContent(value.refusal);
  if (type === "content_block_start" && isRecord(value.content_block)) {
    const block = value.content_block;
    return ["text", "thinking"].includes(String(block.type)) && !block.text && !block.thinking;
  }
  if (Array.isArray(value.choices) && value.choices.length > 0) {
    return value.choices.every((choice) => isRecord(choice) && !choice.finish_reason && !choice.message && !choice.text
      && isRecord(choice.delta) && Object.entries(choice.delta).every(([key, item]) => key === "role"
        || (["content", "reasoning", "reasoning_content"].includes(key) && (item == null || item === ""))));
  }
  // Unknown events may contain output or tool actions. Start forwarding them immediately.
  return false;
}

function streamFormat(prefix: string): "sse" | "body" | undefined {
  const text = prefix.trimStart();
  if (!text) return undefined;
  const fields = ["event:", "data:", "id:", "retry:", ":"];
  if (fields.some((field) => text.startsWith(field))) return "sse";
  // A transport chunk may stop halfway through the first SSE field name.
  if (fields.some((field) => field.startsWith(text))) return undefined;
  return "body";
}

function checkStreamBodyError(text: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return; }
  const error = streamEventErrorMessage(value);
  if (error) throw new Error(error);
}

function readyStreamFrame(frame: string) {
  const parsed = parseSseFrame(frame);
  if (!parsed.data && !frame.trimStart().startsWith("{")) return undefined;
  if (parsed.data === "[DONE]") return "[DONE]";
  const text = parsed.data || frame;
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    // Named heartbeat/error events may carry plain text instead of JSON.
    value = { type: parsed.event, message: text };
  }
  const error = streamEventErrorMessage(value)
    || streamEventErrorMessage({ ...(isRecord(value) ? value : { message: text }), type: parsed.event });
  if (error) throw new Error(error);
  if (isStreamPrelude(value, parsed.event)) return undefined;
  // Keep a bounded event label for failure diagnosis; never retain the event payload here.
  const type = isRecord(value) && typeof value.type === "string" ? value.type : parsed.event;
  return /^[\w.-]{1,100}$/.test(type) ? type : "data";
}

function checkBufferedResponse(text: string, contentType: string) {
  if (!text.trim()) throw new Error("上游返回空响应");
  if (looksLikeHtml(contentType, text)) throw new Error("上游返回了 HTML 页面，请检查 API 地址或代理状态");
  if (streamFormat(text) === "sse") {
    // Non-streaming callers have not received any output yet, even if the buffered SSE has deltas.
    for (const frame of text.split(/\r?\n\r?\n/)) readyStreamFrame(frame);
  } else checkStreamBodyError(text);
}

/** Identify the wire format from bytes: Codex Responses Lite can omit Content-Type entirely. */
async function prepareStreamingResponse(response: Response, signal?: AbortSignal, onStreamReady?: (eventType: string) => void) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const buffered = new StreamPreludeBuffer();
  let pending = "";
  let format: ReturnType<typeof streamFormat>;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let released: Promise<void> | undefined;
  let cancelled: Promise<void> | undefined;
  const release = () => released ??= (async () => {
    signal?.removeEventListener("abort", abort);
    try { await buffered.dispose(); } finally { reader.releaseLock(); }
  })();
  const cancel = (reason: unknown) => cancelled ??= reader.cancel(reason).catch(() => {}).then(release);
  const abort = () => {
    bodyController?.error(signal?.reason);
    // Preparation owns cleanup while it is still parsing. After handoff, abort must also
    // release the spool even when the downstream never pulls another chunk.
    void (bodyController ? cancel(signal?.reason) : reader.cancel(signal?.reason)).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    let ready: string | undefined;
    while (!ready) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) {
        pending += decoder.decode();
        if (format === "sse" || (!pending.trim() && /text\/event-stream/i.test(response.headers.get("content-type") || ""))) {
          ready = pending.trim() ? readyStreamFrame(pending) : undefined;
          if (ready) break;
          throw new Error("上游流在返回内容前结束");
        }
        checkBufferedResponse(pending, response.headers.get("content-type") || "");
        break;
      }
      await buffered.append(chunk.value);
      signal?.throwIfAborted();
      pending += decoder.decode(chunk.value, { stream: true });
      format ??= streamFormat(pending);
      if (format === "sse") {
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, separator.index);
          pending = pending.slice(separator.index + separator[0].length);
          ready = readyStreamFrame(frame);
          if (ready) break;
        }
      }
      // A size limit is a failure, never evidence of output. Codex can echo large instructions
      // in response.created/in_progress before an overload error arrives.
      if (!ready && pending.length > 64 * 1024 * 1024) throw new Error("上游前置响应帧超出大小限制");
    }
    pending = "";
    signal?.throwIfAborted();
    onStreamReady?.(ready || "body");
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; },
      async pull(controller) {
        try {
          signal?.throwIfAborted();
          const prefetched = await buffered.read();
          signal?.throwIfAborted();
          if (prefetched) { controller.enqueue(prefetched); return; }
          await buffered.dispose();
          const chunk = await reader.read();
          signal?.throwIfAborted();
          if (chunk.done) { await release(); controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) {
          try { await cancel(error); } finally { controller.error(error); }
        }
      },
      async cancel(reason) {
        await cancel(reason);
      }
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    await cancel(error);
    throw error;
  }
}

/** Keep body-read failures inside the retry boundary; successful streaming output stays streaming. */
export async function prepareUpstreamResponse(response: Response, downstreamStream: boolean, signal?: AbortSignal, onStreamReady?: (eventType: string) => void) {
  signal?.throwIfAborted();
  if (!response.body) {
    if (response.ok) throw new Error("上游返回空响应");
    return response;
  }
  if (response.ok && downstreamStream) {
    return prepareStreamingResponse(response, signal, onStreamReady);
  }
  const body = await response.arrayBuffer();
  signal?.throwIfAborted();
  if (response.ok) checkBufferedResponse(new TextDecoder().decode(body), response.headers.get("content-type") || "");
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
