import { countTokens as countModern, setMergeCacheSize as setModernCache } from "gpt-tokenizer/encoding/o200k_base";
import { countTokens as countLegacy, setMergeCacheSize as setLegacyCache } from "gpt-tokenizer/encoding/cl100k_base";
import { CL100K_TOKEN_SPLIT_REGEX, O200K_TOKEN_SPLIT_REGEX } from "gpt-tokenizer/encodingParams/constants";
import { isRecord } from "./util/text.js";

setModernCache(4096);
setLegacyCache(4096);
const ordinaryText = { disallowedSpecial: new Set<string>() };

/** Other providers use this encoding as a local estimate, not a billing tokenizer. */
export function tokenEncoding(model = ""): "o200k_base" | "cl100k_base" {
  const name = model.toLowerCase().split("/").at(-1)!;
  return /^gpt-(?:3\.5(?:-|$)|4(?:-|$))/.test(name) ? "cl100k_base" : "o200k_base";
}

export function estimateTextTokens(text: string, model?: string): number {
  return (tokenEncoding(model) === "cl100k_base" ? countLegacy : countModern)(text, ordinaryText);
}

/** Keep only the unfinished tokenizer pieces, not the whole generated reply. */
function textCounter(model?: string) {
  const pattern = tokenEncoding(model) === "cl100k_base" ? CL100K_TOKEN_SPLIT_REGEX : O200K_TOKEN_SPLIT_REGEX;
  let pending = "";
  let tokens = 0;
  return {
    push(text: string) {
      pending += text;
      while (pending.length >= 32768) {
        // A fixed window makes the count independent of network chunk boundaries.
        const window = pending.slice(0, 32768);
        const starts = [...window.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => match.index!);
        // Retain the last two pieces for contractions, whitespace and split Unicode.
        // Extremely long unbroken strings are split to bound memory; their count
        // remains an estimate at that boundary.
        const end = starts.at(-2) || 16384;
        tokens += estimateTextTokens(pending.slice(0, end), model);
        pending = pending.slice(end);
      }
    },
    result(suffix = "") { return tokens + estimateTextTokens(pending + suffix, model); }
  };
}

/** Count the actual upstream context, including instructions, tools and history. */
export function estimateRequestTokens(body: unknown, model?: string): number | undefined {
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return undefined; }
  }
  if (!isRecord(body)) return undefined;
  const actualModel = model ?? (typeof body.model === "string" ? body.model : undefined);
  const count = (value: unknown, depth = 0, schema = false, parentKey = ""): number => {
    if (depth > 128 || value == null) return 0;
    if (typeof value === "string") return /^data:[^,]*;base64,/i.test(value) ? 0 : estimateTextTokens(value, actualModel);
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + count(item, depth + 1, schema) + 3, 0);
    if (isRecord(value)) {
      if (!schema && (["input_image", "image_url", "input_audio", "input_file"].includes(String(value.type))
        || (["inlineData", "inline_data", "fileData", "file_data"].includes(parentKey) && (value.mimeType || value.mime_type)))) return 0;
      return Object.entries(value).reduce((sum, [key, item]) => {
        // Only protocol-defined opaque fields are excluded. A tool result or
        // schema property named data/id/audio is ordinary model-visible content.
        if (!schema && ((value.type === "reasoning" && key === "encrypted_content")
          || (value.type === "thinking" && key === "signature")
          || (value.type === "base64" && key === "data")
          || (value.type === "image" && key === "source"))) return sum;
        return sum + estimateTextTokens(key, actualModel) + 1 + count(item, depth + 1,
          schema || ["parameters", "input_schema", "responseSchema", "response_schema"].includes(key), key);
      }, 0);
    }
    return estimateTextTokens(String(value), actualModel);
  };
  let tokens = 3;
  let found = false;
  for (const field of ["instructions", "system", "systemInstruction", "messages", "input", "contents", "prompt", "tools", "functions"]) {
    if (body[field] !== undefined) { found = true; tokens += count(body[field]); }
  }
  // Message/tool framing and multimodal or hidden content still require upstream usage.
  return found ? tokens : undefined;
}

/** Count decoded output strings while ignoring opaque payloads and duplicate snapshots. */
export function createOutputTokenEstimate(model?: string) {
  type Frame = { path: string[]; array: boolean; key: string; expectKey: boolean; afterColon: boolean };
  const stack: Frame[] = [];
  const makeCounter = () => textCounter(model);
  const deltas = makeCounter();
  let eventFull = makeCounter();
  let eventItem = makeCounter();
  let deferredRoot = makeCounter();
  let deferredText: string | undefined = "";
  let rootInDeltas = false;
  let detachedDeltas = 0;
  let quoted = false;
  let keyString = false;
  let escaped = false;
  let unicode: string | undefined;
  let smallText = "";
  let stringLength = 0;
  let stringPath: string[] = [];
  let target: ReturnType<typeof makeCounter> | undefined;
  let collectRoot = false;
  let type = "";
  let full = 0;
  let itemsDone = 0;
  let itemsAdded = 0;
  let failed = false;
  let invalid = false;
  const responseDelta = () => /^response\.(?:output_text|reasoning_summary_text|reasoning_text|refusal|function_call_arguments|custom_tool_call_input)\.delta$/.test(type);
  const resetEvent = () => {
    type = ""; eventFull = makeCounter(); eventItem = makeCounter(); deferredRoot = makeCounter(); deferredText = ""; rootInDeltas = false;
  };
  const finishEvent = () => {
    if (responseDelta() && !rootInDeltas) {
      if (deferredText !== undefined) deltas.push(deferredText);
      else detachedDeltas += deferredRoot.result();
    }
    if (type === "error" || type.endsWith(".failed") || type.endsWith("_error")) failed = true;
    if (type === "response.output_item.done") itemsDone += eventItem.result();
    if (type === "response.output_item.added") itemsAdded += eventItem.result();
    full = Math.max(full, eventFull.result());
  };
  const stringTarget = () => {
    const path = stringPath[0] === "[]" ? stringPath.slice(1) : stringPath;
    const key = path.at(-1) || "";
    const parent = path.slice(0, -1).join(".");
    if (parent === "" && key === "delta") {
      rootInDeltas = responseDelta();
      collectRoot = !rootInDeltas;
      return rootInDeltas ? deltas : deferredRoot;
    }
    const textField = ["text", "output_text", "thinking", "refusal", "content", "reasoning", "reasoning_content", "arguments", "name", "input", "partial_json"].includes(key);
    if (!textField && !parent.includes(".input.") && !parent.includes(".args.")) return;
    if (parent === "choices.[].delta" || parent.startsWith("choices.[].delta.tool_calls.") || parent === "delta" || parent === "content_block" || parent.startsWith("content_block.input.") || parent.startsWith("candidates.[].content.parts.")) return deltas;
    if (parent.startsWith("item.") || parent === "item") return eventItem;
    if (parent.startsWith("response.output.") || parent.startsWith("output.") || parent.startsWith("content.") || parent.startsWith("choices.[].message") || parent === "choices.[]" || (parent === "" && key === "output_text")) return eventFull;
  };
  const decoded = (text: string) => {
    stringLength += text.length;
    if (smallText.length < 256) smallText += text;
    target?.push(text);
    if (collectRoot && deferredText !== undefined) deferredText = deferredText.length + text.length <= 65536 ? deferredText + text : undefined;
  };
  const finishString = () => {
    const path = stringPath[0] === "[]" ? stringPath.slice(1) : stringPath;
    const key = path.at(-1);
    const parent = path.slice(0, -1).join(".");
    if (path.length === 1 && key === "type") type = smallText;
    if ((parent === "" || parent === "response") && key === "error" && stringLength > 0) failed = true;
  };
  return {
    push(text: string) {
      if (invalid) return;
      for (const char of text) {
        const top = stack.at(-1);
        if (quoted) {
          if (unicode !== undefined) {
            unicode += char;
            if (unicode.length === 4) { decoded(String.fromCharCode(Number.parseInt(unicode, 16))); unicode = undefined; }
          } else if (escaped) {
            escaped = false;
            if (char === "u") { unicode = ""; continue; }
            decoded(({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[char] || char);
          } else if (char === "\\") escaped = true;
          else if (char === '"') {
            quoted = false;
            if (keyString && top) { top.key = smallText; top.expectKey = false; }
            else finishString();
            target = undefined; collectRoot = false;
          } else decoded(char);
          continue;
        }
        if (char === '"') {
          quoted = true;
          keyString = Boolean(top && !top.array && top.expectKey);
          smallText = ""; stringLength = 0; collectRoot = false;
          stringPath = top ? [...top.path, top.array ? "[]" : top.key] : [];
          target = keyString ? undefined : stringTarget();
        } else if (char === ":" && top) top.afterColon = true;
        else if (char === "," && top) { top.expectKey = !top.array; top.afterColon = false; top.key = ""; }
        else if (char === "{" || char === "[") {
          if (stack.length >= 128) { invalid = true; return; }
          if (!top) resetEvent();
          const property = top?.afterColon && !top.array ? top.key : "[]";
          if (property === "error" && (top?.path.length === 0 || top?.path.join(".") === "response")) failed = true;
          if (top) top.afterColon = false;
          stack.push({ path: top ? [...top.path, property] : [], array: char === "[", key: "", expectKey: char === "{", afterColon: false });
        } else if (char === "}" || char === "]") {
          if (stack.length) stack.pop();
          if (!stack.length) finishEvent();
        }
      }
    },
    result() {
      const deferred = stack.length && responseDelta() && !rootInDeltas;
      const deltaTokens = detachedDeltas + deltas.result(deferred ? deferredText || "" : "") + (deferred && deferredText === undefined ? deferredRoot.result() : 0);
      return { outputTokens: Math.max(deltaTokens, full, itemsDone, itemsAdded), failed };
    }
  };
}
