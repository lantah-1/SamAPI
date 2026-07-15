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
import { bodyRecord, isRecord, textFromContent } from "../util/text.js";
import type { ProxyKind, RosettaConverter, RouteEndpointKind } from "../proxy-path.js";

export function systemText(value: unknown) {
  return textFromContent(value);
}

export function anthropicContentToText(value: unknown) {
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

export function anthropicMessagesToOpenAiMessages(body: unknown) {
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

export function anthropicToolsToOpenAiChatTools(body: unknown) {
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

export function anthropicToolsToOpenAiResponseTools(body: unknown) {
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

export function anthropicToolChoiceToOpenAiChat(body: unknown) {
  const toolChoice = bodyRecord(body).tool_choice;
  if (!isRecord(toolChoice)) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

export function commonGenerationOptions(body: unknown) {
  const source = bodyRecord(body);
  return {
    ...(typeof source.temperature === "number" ? { temperature: source.temperature } : {}),
    ...(typeof source.top_p === "number" ? { top_p: source.top_p } : {}),
    ...(typeof source.max_tokens === "number" ? { max_tokens: source.max_tokens } : {}),
    ...(Array.isArray(source.stop_sequences) ? { stop: source.stop_sequences } : {})
  };
}

export function anthropicMessagesToOpenAiChatBody(body: unknown, routeModel: string) {
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

export function anthropicMessagesToOpenAiResponsesBody(body: unknown, routeModel: string) {
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

export function isStreamingRequest(body: unknown) {
  return bodyRecord(body).stream === true;
}

export function rosettaConverter(proxyKind: ProxyKind, routeEndpoint: RouteEndpointKind): RosettaConverter | undefined {
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

export function applyRouteModel(payload: unknown, routeModel: string) {
  if (isRecord(payload)) return { ...payload, model: routeModel };
  return payload;
}

export function normalizeGeminiConverterInput(body: unknown, routeModel: string) {
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

export function convertedRouteRequestBody(body: unknown, routeModel: string, routeEndpoint: RouteEndpointKind, proxyKind: ProxyKind) {
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

export function geminiContentsToMessages(body: unknown) {
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

export function geminiSystemText(body: unknown) {
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

export function geminiGenerationConfig(body: unknown) {
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

export function routeRequestBody(body: unknown, routeModel: string, routeEndpoint: string, proxyKind: ProxyKind) {
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

export function extractResponseText(payload: unknown): string {
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

export function openAiMessagesFromAnyBody(body: unknown) {
  const source = bodyRecord(body);
  if (Array.isArray(source.messages)) return source.messages;
  if (Array.isArray(source.input)) return source.input;
  if (typeof source.input === "string") return [{ role: "user", content: source.input }];
  if (Array.isArray(source.contents)) return geminiContentsToMessages(body);
  return [];
}

export function applyStreamingFlag(body: unknown, stream: boolean) {
  return isRecord(body) ? { ...body, stream } : body;
}

export function sanitizeOpenAiCompatibleResponsesBody(body: unknown, routeEndpoint: RouteEndpointKind) {
  if (routeEndpoint !== "responses" || !isRecord(body)) return body;
  const sanitized = { ...body };
  delete sanitized.metadata;
  return sanitized;
}
