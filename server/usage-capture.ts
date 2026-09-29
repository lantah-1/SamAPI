import { randomUUID } from "node:crypto";
import type { TokenUsage, UsageRecordInput } from "../shared/usage.js";
import { normalizeServiceTier } from "../shared/usage.js";
import { isRecord } from "./util/text.js";
import { createOutputTokenEstimate, tokenEncoding } from "./usage-estimate.js";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Read cache markers from the payload actually sent upstream, never from text content. */
export function requestCacheMode(body: unknown): NonNullable<UsageRecordInput["cacheMode"]> {
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return "implicit"; } }
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

export function requestServiceTier(body: unknown): string | undefined {
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return undefined; } }
  return isRecord(body) ? normalizeServiceTier(body.service_tier) : undefined;
}

export function usageFields(value: unknown): Partial<TokenUsage> {
  if (!isRecord(value)) return {};
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const cached = count(inputDetails.cached_tokens ?? value.prompt_cache_hit_tokens ?? value.cache_read_input_tokens ?? value.cachedContentTokenCount);
  const writes = count(inputDetails.cache_write_tokens ?? value.cache_creation_input_tokens ?? inputDetails.cache_creation_input_tokens);
  const longWrites = isRecord(value.cache_creation) ? count(value.cache_creation.ephemeral_1h_input_tokens) : undefined;
  let input = count(value.input_tokens ?? value.prompt_tokens ?? value.promptTokenCount);
  let output = count(value.output_tokens ?? value.completion_tokens ?? value.candidatesTokenCount);
  const thoughts = count(value.thoughtsTokenCount);
  const anthropic = "cache_read_input_tokens" in value || "cache_creation_input_tokens" in value;
  if (input !== undefined && anthropic) input += (cached || 0) + (writes || 0);
  if (input === undefined && cached !== undefined && count(value.prompt_cache_miss_tokens) !== undefined) input = cached + (count(value.prompt_cache_miss_tokens) || 0);
  if (output !== undefined) output += thoughts || 0;
  const total = count(value.total_tokens ?? value.totalTokenCount);
  if (total !== undefined) {
    if (input !== undefined && output === undefined && total >= input) output = total - input;
    if (output !== undefined && input === undefined && total >= output) input = total - output;
  }
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(writes === undefined ? {} : { cacheWriteInputTokens: writes }),
    ...(longWrites === undefined ? {} : { cacheWriteLongInputTokens: longWrites }),
    ...(output === undefined ? {} : { outputTokens: output })
  };
}

/** Scan only usage objects, without buffering full replies, tool arguments or image data. */
export function createUsageCapture() {
  type Frame = { kind: "object" | "array"; path: string[]; key: string; expectKey: boolean; afterColon: boolean };
  const stack: Frame[] = [];
  let quoted = false;
  let escaped = false;
  let keyString = false;
  let tierString = false;
  let keyText = "";
  let capture: { text: string; depth: number; overflow: boolean } | undefined;
  const values: Partial<TokenUsage> = {};
  let serviceTier: string | undefined;
  const merge = (payload: unknown, messageStart: boolean) => {
    if (isRecord(payload)) serviceTier = normalizeServiceTier(payload.service_tier) ?? serviceTier;
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
        if ((keyString || tierString) && keyText.length < 256) keyText += char;
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === '"') {
          quoted = false;
          if (keyString && top) {
            try { top.key = JSON.parse(`"${keyText}`) as string; } catch { top.key = ""; }
            top.expectKey = false;
          } else if (tierString) {
            try { serviceTier = normalizeServiceTier(JSON.parse(`"${keyText}`)) ?? serviceTier; } catch { /* Ignore malformed metadata. */ }
          }
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
        keyString = top?.kind === "object" && top.expectKey;
        tierString = !keyString && top?.key === "service_tier" && (top.path.length === 0 || (top.path.length === 1 && ["response", "message", "[]"].includes(top.path[0])));
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
    serviceTier(): string | undefined { return invalid ? undefined : serviceTier; },
    partial(): Partial<TokenUsage> { return invalid ? {} : { ...values }; },
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
  observer?: { push: (text: string) => void; finish: () => void },
  options: { inputTokenEstimate?: number | (() => number | undefined); signal?: AbortSignal } = {}
) {
  const record: UsageRecordInput = { ...context, id: `usage-${randomUUID()}`, createdAt: new Date().toISOString(), statusCode: response.status, finalized: false };
  save(record);
  const capture = createUsageCapture();
  const estimate = createOutputTokenEstimate(context.model);
  const decoder = new TextDecoder();
  let finished = false;
  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true;
    const finalText = decoder.decode();
    capture.push(finalText);
    estimate.push(finalText);
    observer?.push(finalText);
    observer?.finish();
    let usage = capture.result();
    let estimation: UsageRecordInput["estimation"];
    const observed = estimate.result();
    const failed = !response.ok || observed.failed || Boolean(error) || options.signal?.aborted;
    const partial = capture.partial();
    const outputTokens = partial.outputTokens ?? observed.outputTokens;
    const reportedCacheTokens = (partial.cachedInputTokens || 0) + (partial.cacheWriteInputTokens || 0);
    const rejected = failed && outputTokens === 0 && partial.inputTokens === undefined && reportedCacheTokens === 0;
    const inputEstimate = usage ? undefined : partial.inputTokens ?? (rejected && options.inputTokenEstimate !== undefined ? 0
      : typeof options.inputTokenEstimate === "function" ? options.inputTokenEstimate() : options.inputTokenEstimate);
    if (!usage && inputEstimate !== undefined) {
      const inputTokens = partial.inputTokens ?? Math.max(rejected ? 0 : inputEstimate, reportedCacheTokens);
      const cachedInputTokens = Math.min(partial.cachedInputTokens || 0, inputTokens);
      const cacheWriteInputTokens = Math.min(partial.cacheWriteInputTokens || 0, inputTokens - cachedInputTokens);
      usage = { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens,
        ...(partial.cacheWriteLongInputTokens === undefined ? {} : { cacheWriteLongInputTokens: Math.min(partial.cacheWriteLongInputTokens, cacheWriteInputTokens) }), totalTokens: inputTokens + outputTokens };
      estimation = { method: rejected ? "rejected" : "content", inputEstimated: partial.inputTokens === undefined, outputEstimated: partial.outputTokens === undefined,
        ...(rejected ? {} : { tokenizer: tokenEncoding(context.model), ...(partial.cachedInputTokens === undefined && partial.cacheWriteInputTokens === undefined ? { cacheUsageMissing: true } : {}) }) };
    }
    save({ ...record, finalized: true, usage, estimation, serviceTier: capture.serviceTier() ?? record.serviceTier,
      statusCode: response.ok && failed ? options.signal?.aborted ? 499 : 599 : response.status });
  };
  if (!response.body) { finish(response.ok ? new Error("empty response") : undefined); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { finish(); reader.releaseLock(); controller.close(); return; }
        const text = decoder.decode(chunk.value, { stream: true });
        capture.push(text);
        estimate.push(text);
        observer?.push(text);
        controller.enqueue(chunk.value);
      } catch (error) {
        finish(error);
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
