export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  /**
   * Tool calls made by the assistant in this message (assistant role only).
   * Recorded so the model sees its own prior tool use in later requests.
   */
  toolCalls?: JsonToolCall[];
  /**
   * ID of the assistant tool call this message responds to (tool role only).
   * Must match a `toolCalls[].id` from the preceding assistant message.
   */
  toolCallId?: string;
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
  /**
   * Abort the HTTP request.  Honoured by `complete()`; `stream()` also links
   * it to the stream's own controller (which `StreamResult.cancel()` aborts).
   */
  signal?: AbortSignal;
}

/** Token counts for one model call (or running totals across calls). */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's cache, when reported. */
  cachedTokens?: number;
  /** Completion tokens spent on reasoning, when reported. */
  reasoningTokens?: number;
}

export type FinishReason = "stop" | "length" | "content_filter" | "tool_calls" | null;

export interface AIResponse {
  id: string;
  model: string;
  content: string | null;
  finishReason: FinishReason;
  toolCalls?: JsonToolCall[];
  usage?: Usage;
}

/**
 * Result of a streaming request — provides concurrent text + tool call streams.
 *
 * Contract for providers:
 *  - `textStream` yields text deltas.  It MAY yield an empty string `""` as
 *    a heartbeat for a received chunk that carries no text (tool-call
 *    argument deltas, reasoning, keep-alives) so consumers can tell an
 *    active stream from a silent one — the interpreter's idle timeout counts
 *    `""` as activity but never emits or records it.  Consumers that only
 *    concatenate text are unaffected.
 *  - `toolCalls`, `finishReason` and `usage` resolve once the stream ends —
 *    and also after `cancel()` or a stream error (with whatever was
 *    received); they never reject.
 *  - `cancel()` aborts the underlying request and must never block, even
 *    when the server has not responded at all.
 */
export interface StreamResult {
  textStream: AsyncIterableIterator<string>;
  toolCalls: Promise<JsonToolCall[]>;
  /** Resolves with the finish reason from the final chunk, or null if absent. */
  finishReason: Promise<FinishReason>;
  /** Token usage for the request, if the provider reports it. */
  usage?: Promise<Usage | undefined>;
  cancel(): Promise<void>;
}

export interface AIProvider {
  readonly name: string;
  complete(config: AIRequestConfig): Promise<AIResponse>;
  /** See `StreamResult` for the streaming contract (heartbeats, cancel). */
  stream(config: AIRequestConfig): StreamResult;
}

export interface AIProviderConfig {
  apiKey: string;
  /** Override the API root, e.g. `http://localhost:8080/v1` for a local OpenAI-compatible server. */
  baseUrl?: string;
  defaultModel?: string;
  /** Required for browser usage — identifies your app to OpenRouter */
  httpReferer?: string;
  /** Optional app name shown on OpenRouter dashboard */
  xTitle?: string;
}

/** A value or a function that returns a value (resolved at query time). */
export type Lazy<T> = T | (() => T);
