export type MessageRole = "system" | "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string;
}

export interface ProviderRouting {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allowFallbacks?: boolean;
  sort?: "price" | "throughput" | "latency" | { by: "price" | "throughput" | "latency"; partition?: "model" | "none" };
  preferredMaxLatency?: number | { p50?: number; p75?: number; p90?: number; p99?: number };
}

// ---- JSON tool calling types (OpenAI-compatible format) ----

export interface JsonToolParameter {
  type: string;
  description?: string;
  enum?: string[];
}

export interface JsonToolFunction {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonToolParameter>;
    required?: string[];
  };
}

export interface JsonTool {
  type: "function";
  function: JsonToolFunction;
}

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

/** A completed tool call returned by the model */
export interface JsonToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded arguments
  };
}

export interface AIRequestConfig {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  seed?: number;
  provider?: ProviderRouting;
  tools?: JsonTool[];
  toolChoice?: ToolChoice;
}

export interface AIResponse {
  id: string;
  model: string;
  content: string | null;
  finishReason: "stop" | "length" | "content_filter" | "tool_calls" | null;
  toolCalls?: JsonToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Result of a streaming request — provides concurrent text + tool call streams */
export interface StreamResult {
  textStream: AsyncIterableIterator<string>;
  toolCalls: Promise<JsonToolCall[]>;
  cancel(): Promise<void>;
}

export interface AIProvider {
  readonly name: string;
  complete(config: AIRequestConfig): Promise<AIResponse>;
  stream(config: AIRequestConfig): StreamResult;
}

export interface AIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

/** A value or a function that returns a value (resolved at query time). */
export type Lazy<T> = T | (() => T);
