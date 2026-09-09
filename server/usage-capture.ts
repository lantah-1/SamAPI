import { randomUUID } from "node:crypto";
import type { TokenUsage, UsageRecordInput } from "../shared/usage.js";
import { isRecord } from "./util/text.js";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Read cache markers from the payload actually sent upstream, never from text content. */
export function requestCacheMode(body: unknown): NonNullable<UsageRecordInput["cacheMode"]> {
  const pending: unknown[] = [body];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { for (const child of value) pending.push(child); }
    else if (isRecord(value)) {
      if (isRecord(value.cache_control) && value.cache_control.type === "ephemeral") return "explicit";
      for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
    }
  }
  return "implicit";
}

export function usageFields(value: unknown): Partial<TokenUsage> {
  if (!isRecord(value)) return {};
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const cached = count(inputDetails.cached_tokens ?? value.prompt_cache_hit_tokens ?? value.cache_read_input_tokens ?? value.cachedContentTokenCount);
  const writes = count(value.cache_creation_input_tokens ?? inputDetails.cache_creation_input_tokens);
  const longWrites = isRecord(value.cache_creation) ? count(value.cache_creation.ephemeral_1h_input_tokens) : undefined;
  const input = count(value.input_tokens ?? value.prompt_tokens ?? value.promptTokenCount);
  const output = count(value.output_tokens ?? value.completion_tokens ?? value.candidatesTokenCount);
  const thoughts = count(value.thoughtsTokenCount);
  const anthropic = "cache_read_input_tokens" in value || "cache_creation_input_tokens" in value;
  return {
    ...(input === undefined ? {} : { inputTokens: input + (anthropic ? (cached || 0) + (writes || 0) : 0) }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(writes === undefined ? {} : { cacheWriteInputTokens: writes }),
    ...(longWrites === undefined ? {} : { cacheWriteLongInputTokens: longWrites }),
    ...(output === undefined ? {} : { outputTokens: output + (thoughts || 0) })
  };
}

/** Scan only usage objects, without buffering full replies, tool arguments or image data. */
export function createUsageCapture() {
  type Frame = { kind: "object" | "array"; path: string[]; key: string; expectKey: boolean; afterColon: boolean };
  const stack: Frame[] = [];
  let quoted = false;
  let escaped = false;
  let keyString = false;
  let keyText = "";
  let capture: { text: string; depth: number; overflow: boolean } | undefined;
  const values: Partial<TokenUsage> = {};
  const merge = (payload: unknown, messageStart: boolean) => {
    for (const [key, value] of Object.entries(usageFields(payload))) {
      const field = key as keyof TokenUsage;
      // Anthropic message_start reports an initial output count, not the final output usage.
      if (messageStart && field === "outputTokens") continue;
      if (value !== undefined) values[field] = Math.max(values[field] || 0, value);
    }
  };
  let invalid = false;
  const push = (text: string) => {
    if (invalid) return;
    for (const char of text) {
      if (capture && !capture.overflow) {
        if (capture.text.length < 65536) capture.text += char;
        else { capture.text = ""; capture.overflow = true; }
      }
      const top = stack.at(-1);
      if (quoted) {
        if (keyString && keyText.length < 256) keyText += char;
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === '"') {
          quoted = false;
          if (keyString && top) {
            try { top.key = JSON.parse(`"${keyText}`) as string; } catch { top.key = ""; }
            top.expectKey = false;
          }
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
        keyString = top?.kind === "object" && top.expectKey;
        keyText = "";
      } else if (char === ":" && top) {
        top.afterColon = true;
      } else if (char === "," && top) {
        top.expectKey = top.kind === "object";
        top.afterColon = false;
        top.key = "";
      } else if (char === "{" || char === "[") {
        if (stack.length >= 128) { invalid = true; stack.length = 0; capture = undefined; return; }
        const property = top?.kind === "object" && top.afterColon ? top.key : "[]";
        if (char === "{" && top && ["usage", "usageMetadata"].includes(property)
          && (top.path.length === 0 || (top.path.length === 1 && ["response", "message", "[]"].includes(top.path[0])))) {
          capture = { text: "{", depth: stack.length, overflow: false };
        }
        if (top) top.afterColon = false;
        stack.push({ kind: char === "{" ? "object" : "array", path: top ? [...top.path, property] : [], key: "", expectKey: char === "{", afterColon: false });
      } else if (char === "}" || char === "]") {
        stack.pop();
        if (capture && stack.length === capture.depth) {
          if (!capture.overflow) {
            try { merge(JSON.parse(capture.text), stack.at(-1)?.path[0] === "message"); } catch { /* Invalid usage must remain unknown. */ }
          }
          capture = undefined;
        }
      }
    }
  };
  return {
    push,
    result(): TokenUsage | undefined {
      if (invalid || values.inputTokens === undefined || values.outputTokens === undefined || !Number.isSafeInteger(values.inputTokens + values.outputTokens)) return undefined;
      const cachedInputTokens = Math.min(values.cachedInputTokens || 0, values.inputTokens);
      const cacheWriteInputTokens = Math.min(values.cacheWriteInputTokens || 0, values.inputTokens - cachedInputTokens);
      return { inputTokens: values.inputTokens, outputTokens: values.outputTokens, cachedInputTokens, cacheWriteInputTokens, ...(values.cacheWriteLongInputTokens === undefined ? {} : { cacheWriteLongInputTokens: Math.min(values.cacheWriteLongInputTokens, cacheWriteInputTokens) }), totalTokens: values.inputTokens + values.outputTokens };
    }
  };
}

export function captureUsageResponse(
  response: Response,
  context: Omit<UsageRecordInput, "id" | "createdAt" | "statusCode" | "usage">,
  save: (record: UsageRecordInput) => void,
  observer?: { push: (text: string) => void; finish: () => void }
) {
  const record: UsageRecordInput = { ...context, id: `usage-${randomUUID()}`, createdAt: new Date().toISOString(), statusCode: response.status };
  save(record);
  if (!response.body) return response;
  const capture = createUsageCapture();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const finalText = decoder.decode();
    capture.push(finalText);
    observer?.push(finalText);
    observer?.finish();
    save({ ...record, usage: capture.result() });
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { finish(); reader.releaseLock(); controller.close(); return; }
        const text = decoder.decode(chunk.value, { stream: true });
        capture.push(text);
        observer?.push(text);
        controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
