import { createHash } from "node:crypto";
import { contentText, limitLogText, responseLogText, userMessages } from "./log-content.js";
import { isRecord } from "./util/text.js";

export interface LogToolResult {
  callId?: string;
  name?: string;
  text: string;
  failed: boolean;
}

export interface LogRequestContext {
  scope: string;
  correlationKey?: string;
  currentMessage?: string;
  isRootTurn: boolean;
  previousResponseId?: string;
  toolResults: LogToolResult[];
}

export interface LogResponseTool {
  key: string;
  callId?: string;
  name: string;
  completed?: boolean;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 1024 ? value.trim() : undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length > 65536) return {};
  try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : {}; } catch { return {}; }
}

function hash(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function currentUserMessages(body: unknown): string[] {
  return userMessages(body).slice(-1);
}

function requestItems(body: Record<string, unknown>): unknown[] {
  return Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : Array.isArray(body.contents) ? body.contents : [];
}

/** Only callbacks after the latest real user input can continue that input's turn. */
export function requestToolResults(body: unknown): LogToolResult[] {
  if (!isRecord(body)) return [];
  const items = requestItems(body);
  let lastUser = -1;
  items.forEach((item, index) => {
    if (isRecord(item) && (item.role === "user" || (item.role === undefined && (item.type === "message" || item.parts)))
      && contentText(item.content ?? item.parts)) lastUser = index;
  });
  const results: LogToolResult[] = [];
  for (const item of items.slice(Math.max(0, lastUser))) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      results.push({ callId: identifier(item.call_id), text: limitLogText(contentText(item.output) || responseLogText(item.output)), failed: item.is_error === true });
    } else if (item.role === "tool" || item.role === "function") {
      results.push({ callId: identifier(item.tool_call_id), name: identifier(item.name), text: limitLogText(contentText(item.content) || responseLogText(item.content)), failed: item.is_error === true });
    }
    const parts = Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (part.type === "tool_result") {
        results.push({ callId: identifier(part.tool_use_id), text: limitLogText(contentText(part.content) || responseLogText(part.content)), failed: part.is_error === true });
      } else if (isRecord(part.functionResponse)) {
        const fn = part.functionResponse;
        results.push({ callId: identifier(fn.id), name: identifier(fn.name), text: responseLogText(fn.response), failed: isRecord(fn.response) && Boolean(fn.response.error) });
      }
    }
  }
  return results;
}

/** Explicit turn IDs and tool/response IDs are evidence; equal prompt text is not. */
export function logRequestContext(headers: Record<string, string>, body: unknown, clientScope: string): LogRequestContext {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const payload = isRecord(body) ? body : {};
  const metadata = jsonRecord(payload.metadata);
  const codex = jsonRecord(lower["x-codex-turn-metadata"]);
  const anthropicUser = jsonRecord(metadata.user_id);
  const session = identifier(lower["x-samapi-session-id"] || lower["session-id"] || lower["session_id"] || lower["x-session-id"]
    || lower["thread-id"] || lower["x-thread-id"] || codex.session_id || codex.thread_id
    || metadata.session_id || anthropicUser.session_id || payload.conversation_id || payload.session_id);
  const rootTurn = identifier(codex.root_turn_id);
  const turn = identifier(lower["x-samapi-turn-id"] || lower["x-turn-id"] || lower["turn-id"] || codex.turn_id || metadata.turn_id);
  const currentMessage = currentUserMessages(body)[0];
  return {
    scope: hash([clientScope, session || ""]),
    correlationKey: rootTurn ? hash([clientScope, "root-turn", rootTurn]) : turn ? hash([clientScope, session || "", "turn", turn]) : undefined,
    currentMessage,
    isRootTurn: Boolean(rootTurn && rootTurn === identifier(codex.turn_id)),
    previousResponseId: !currentMessage ? identifier(payload.previous_response_id) : undefined,
    toolResults: requestToolResults(body)
  };
}

export function legacyLogScope(headers: Record<string, string>): string | undefined {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const metadata = jsonRecord(lower["x-codex-turn-metadata"]);
  const session = identifier(lower["session-id"] || lower["thread-id"] || lower["x-samapi-session-id"] || metadata.session_id || metadata.thread_id);
  return session ? `legacy:${hash([session])}` : undefined;
}

/** Extract only transport metadata, never tool-looking text in the model's answer. */
export function responseLogLinks(payload: unknown): { responseIds: string[]; tools: LogResponseTool[] } {
  const responseIds: string[] = [];
  const tools: LogResponseTool[] = [];
  if (!isRecord(payload)) return { responseIds, tools };
  const response = isRecord(payload.response) ? payload.response : isRecord(payload.message) && payload.type === "message_start" ? payload.message : payload;
  const responseId = identifier(response.id);
  if (responseId && (response.output || response.choices || response.content || response.object || response.type === "message" || payload.response)) responseIds.push(responseId);
  const addTool = (item: unknown, key: string) => {
    if (!isRecord(item)) return;
    const fn = isRecord(item.function) ? item.function : item;
    const name = identifier(fn.name);
    if (!name) return;
    const callId = identifier(item.call_id || item.id);
    tools.push({ key, callId, name });
  };
  if (Array.isArray(response.choices)) response.choices.forEach((choice, choiceIndex) => {
    if (!isRecord(choice)) return;
    const message = isRecord(choice.message) ? choice.message : isRecord(choice.delta) ? choice.delta : {};
    if (Array.isArray(message.tool_calls)) message.tool_calls.forEach((call, index) => addTool(call, `chat:${choiceIndex}:${isRecord(call) ? call.index ?? index : index}`));
    if (isRecord(message.function_call)) addTool(message.function_call, `chat:${choiceIndex}:function`);
  });
  if (Array.isArray(response.output)) response.output.forEach((item, index) => {
    if (isRecord(item) && ["function_call", "custom_tool_call"].includes(String(item.type))) addTool(item, `responses:${index}`);
  });
  if (isRecord(payload.item) && ["function_call", "custom_tool_call"].includes(String(payload.item.type))) addTool(payload.item, `responses:${payload.output_index ?? 0}`);
  if (Array.isArray(response.content)) response.content.forEach((item, index) => {
    if (isRecord(item) && item.type === "tool_use") addTool(item, `anthropic:${index}`);
  });
  if (isRecord(payload.content_block) && payload.content_block.type === "tool_use") addTool(payload.content_block, `anthropic:${payload.index ?? 0}`);
  if (Array.isArray(response.candidates)) response.candidates.forEach((candidate, candidateIndex) => {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) return;
    candidate.content.parts.forEach((part, index) => {
      if (isRecord(part) && part.functionCall) addTool(part.functionCall, `gemini:${candidateIndex}:${index}`);
    });
  });
  return { responseIds, tools };
}
