import { parseSseFrame, streamEventErrorMessage } from "./convert/stream.js";
import { StreamPreludeBuffer } from "./stream-prelude-buffer.js";
import { isRecord, looksLikeHtml } from "./util/text.js";

const streamHeartbeats = new Set(["ping", "keepalive", "keep-alive", "keep_alive", "heartbeat"]);
const streamTerminalEvents = new Set(["response.completed", "response.incomplete", "message_stop"]);
const encoder = new TextEncoder();

export interface UpstreamResponseOptions {
  /** Retry a stream that fails after useful output has already been released downstream. */
  retryStreamFailure?: (error: Error) => Promise<Response | undefined>;
  /** A previous attempt has already emitted useful output on this downstream response. */
  streamContinuation?: boolean;
}

function hasStreamContent(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.some(hasStreamContent);
  if (isRecord(value)) {
    if (["text", "output_text", "summary_text", "reasoning_text"].includes(String(value.type))) return hasStreamContent(value.text);
    if (value.type === "refusal") return hasStreamContent(value.refusal);
    if (value.type === "thinking") return hasStreamContent(value.thinking);
  }
  return true;
}

function isOutputItemPrelude(item: unknown) {
  if (item == null) return true;
  if (!isRecord(item)) return false;
  if (item.type === "message") return !hasStreamContent(item.content);
  if (item.type === "reasoning") return !hasStreamContent(item.summary) && !hasStreamContent(item.content);
  return false;
}

function isStreamPrelude(value: unknown, eventName: string) {
  const type = isRecord(value) && typeof value.type === "string" ? value.type : eventName;
  if (streamHeartbeats.has(type)) return true;
  if (!isRecord(value)) return false;
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
  return false;
}

function streamFormat(prefix: string): "sse" | "body" | undefined {
  const text = prefix.trimStart();
  if (!text) return undefined;
  const fields = ["event:", "data:", "id:", "retry:", ":"];
  if (fields.some((field) => text.startsWith(field))) return "sse";
  if (fields.some((field) => field.startsWith(text))) return undefined;
  return "body";
}

function checkStreamBodyError(text: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return; }
  const error = streamEventErrorMessage(value);
  if (error) throw new Error(error);
}

function inspectStreamFrame(frame: string, strict = false): { ready?: string; terminal?: boolean } {
  const parsed = parseSseFrame(frame.replace(/^\uFEFF/, ""));
  if (!parsed.data && !frame.trimStart().startsWith("{")) return {};
  if (parsed.data === "[DONE]") return { ready: "[DONE]", terminal: true };
  const text = parsed.data || frame;
  let value: unknown;
  let malformed = false;
  try { value = JSON.parse(text); } catch {
    value = { type: parsed.event, message: text };
    malformed = true;
  }
  const error = streamEventErrorMessage(value)
    || streamEventErrorMessage({ ...(isRecord(value) ? value : { message: text }), type: parsed.event });
  if (error) throw new Error(error);
  if (strict && malformed && !streamHeartbeats.has(parsed.event)) throw new Error("上游流包含无效 JSON 事件");
  if (isStreamPrelude(value, parsed.event)) return {};
  const type = isRecord(value) && typeof value.type === "string" ? value.type : parsed.event;
  return { ready: /^[\w.-]{1,100}$/.test(type) ? type : "data", terminal: streamTerminalEvents.has(type) };
}

function isUpstreamErrorFrame(frame: string) {
  const parsed = parseSseFrame(frame.replace(/^\uFEFF/, ""));
  if (parsed.event === "error") return true;
  const text = parsed.data || frame;
  try {
    const value: unknown = JSON.parse(text);
    return Boolean(streamEventErrorMessage(value)
      || streamEventErrorMessage({ ...(isRecord(value) ? value : { message: text }), type: parsed.event }));
  } catch {
    return false;
  }
}

function checkBufferedResponse(text: string, contentType: string) {
  if (!text.trim()) throw new Error("上游返回空响应");
  if (looksLikeHtml(contentType, text)) throw new Error("上游返回了 HTML 页面，请检查 API 地址或代理状态");
  if (streamFormat(text) === "sse") {
    for (const frame of text.split(/\r?\n\r?\n/)) inspectStreamFrame(frame);
  } else checkStreamBodyError(text);
}

async function* replay(buffer: StreamPreludeBuffer) {
  try {
    let chunk: Uint8Array | undefined;
    while ((chunk = await buffer.read())) yield chunk;
  } finally {
    await buffer.dispose();
  }
}

type AttemptOutcome = { kind: "complete" } | { kind: "failure"; error: Error; rawFrame?: Uint8Array };

async function* readStreamingAttempt(input: {
  response: Response;
  signal?: AbortSignal;
  strict: boolean;
  suppressPrelude: boolean;
  state: { started: boolean };
  onStreamReady?: (eventType: string) => void;
}): AsyncGenerator<Uint8Array, AttemptOutcome> {
  const reader = input.response.body!.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: input.strict, ignoreBOM: true });
  const prelude = new StreamPreludeBuffer();
  let pending = "";
  let format: ReturnType<typeof streamFormat>;
  let attemptReady = false;
  let terminal = false;
  let readerFinished = false;
  const abort = () => { void reader.cancel(input.signal?.reason).catch(() => {}); };
  input.signal?.addEventListener("abort", abort, { once: true });

  const processFrame = async function* (frame: string, separator: string): AsyncGenerator<Uint8Array, AttemptOutcome | undefined> {
    const rawFrame = encoder.encode(frame + separator);
    let inspected: ReturnType<typeof inspectStreamFrame>;
    try { inspected = inspectStreamFrame(frame, input.strict); }
    catch (error) {
      return { kind: "failure", error: error instanceof Error ? error : new Error(String(error)), ...(isUpstreamErrorFrame(frame) ? { rawFrame } : {}) };
    }
    if (!attemptReady && !inspected.ready) {
      await prelude.append(rawFrame);
      return undefined;
    }
    if (!attemptReady) {
      attemptReady = true;
      input.state.started = true;
      input.onStreamReady?.(inspected.ready || "data");
      if (input.suppressPrelude) await prelude.dispose();
      else yield* replay(prelude);
    }
    yield rawFrame;
    if (inspected.terminal) {
      terminal = true;
      await reader.cancel().catch(() => {});
      readerFinished = true;
      return { kind: "complete" };
    }
    return undefined;
  };

  try {
    while (true) {
      input.signal?.throwIfAborted();
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); }
      catch (error) { return { kind: "failure", error: error instanceof Error ? error : new Error(String(error)) }; }
      input.signal?.throwIfAborted();
      if (chunk.done) {
        readerFinished = true;
        pending += decoder.decode();
        if (format === "sse" || (!pending.trim() && /text\/event-stream/i.test(input.response.headers.get("content-type") || ""))) {
          if (pending.trim()) {
            const iterator = processFrame(pending, "");
            let item = await iterator.next();
            while (!item.done) { yield item.value; item = await iterator.next(); }
            if (item.value) return item.value;
          }
          if (terminal) return { kind: "complete" };
          if (input.state.started && !input.strict) return { kind: "complete" };
          const message = input.state.started ? "上游流在完整结束前中断（缺少结束事件）" : "上游流在返回内容前结束";
          return { kind: "failure", error: new Error(message) };
        }
        try { checkBufferedResponse(pending, input.response.headers.get("content-type") || ""); }
        catch (error) { return { kind: "failure", error: error instanceof Error ? error : new Error(String(error)) }; }
        input.state.started = true;
        input.onStreamReady?.("body");
        if (pending) yield encoder.encode(pending);
        return { kind: "complete" };
      }

      pending += decoder.decode(chunk.value, { stream: true });
      format ??= streamFormat(pending);
      if (format === "body") {
        if (pending.length > 64 * 1024 * 1024) return { kind: "failure", error: new Error("上游响应帧超出大小限制") };
        continue;
      }
      if (format !== "sse") continue;
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        const iterator = processFrame(frame, separator[0]);
        let item = await iterator.next();
        while (!item.done) { yield item.value; item = await iterator.next(); }
        if (item.value) return item.value;
      }
      if (!attemptReady && pending.length > 64 * 1024 * 1024) return { kind: "failure", error: new Error("上游响应帧超出大小限制") };
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
    await prelude.dispose();
    if (!readerFinished) await reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Already released by the runtime. */ }
  }
}

async function* retryingStreamingBody(response: Response, signal: AbortSignal | undefined, onStreamReady: ((eventType: string) => void) | undefined, options: UpstreamResponseOptions) {
  const state = { started: options.streamContinuation === true };
  let current = response;
  let suppressPrelude = state.started;
  while (true) {
    const iterator = readStreamingAttempt({ response: current, signal, strict: Boolean(options.retryStreamFailure), suppressPrelude, state, onStreamReady });
    let item: Awaited<ReturnType<typeof iterator.next>>;
    try {
      item = await iterator.next();
      while (!item.done) { yield item.value; item = await iterator.next(); }
    } finally {
      await iterator.return({ kind: "complete" });
    }
    if (item.value.kind === "complete") return;

    // Before the first useful frame, keep the failure in the ordinary fetch retry/failover path so
    // a successful replacement can still provide its own response metadata and opening events.
    if (!state.started) throw item.value.error;

    const next = await options.retryStreamFailure?.(item.value.error);
    if (next?.ok && next.body) {
      current = next;
      suppressPrelude = true;
      continue;
    }
    if (state.started && item.value.rawFrame) return;
    throw item.value.error;
  }
}

async function prepareStreamingResponse(response: Response, signal?: AbortSignal, onStreamReady?: (eventType: string) => void, options: UpstreamResponseOptions = {}) {
  const iterator = retryingStreamingBody(response, signal, onStreamReady, options);
  const first = await iterator.next();
  if (first.done) throw new Error("上游返回空响应");
  let firstChunk: Uint8Array | undefined = first.value;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        if (firstChunk) {
          const chunk = firstChunk;
          firstChunk = undefined;
          controller.enqueue(chunk);
          return;
        }
        const next = await iterator.next();
        signal?.throwIfAborted();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        try { await iterator.return(undefined); } finally { controller.error(error); }
      }
    },
    async cancel() { await iterator.return(undefined); }
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Validate the prelude, then forward complete safe frames immediately. Retryable error frames are withheld while a retry is available. */
export async function prepareUpstreamResponse(response: Response, downstreamStream: boolean, signal?: AbortSignal, onStreamReady?: (eventType: string) => void, options: UpstreamResponseOptions = {}) {
  signal?.throwIfAborted();
  if (!response.body) {
    if (response.ok) throw new Error("上游返回空响应");
    return response;
  }
  if (response.ok && downstreamStream) return prepareStreamingResponse(response, signal, onStreamReady, options);
  const body = await response.arrayBuffer();
  signal?.throwIfAborted();
  if (response.ok) checkBufferedResponse(new TextDecoder().decode(body), response.headers.get("content-type") || "");
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
