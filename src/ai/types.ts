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
}

export interface AIResponse {
  id: string;
  model: string;
  content: string | null;
  finishReason: "stop" | "length" | "content_filter" | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIStreamChunk {
  id: string;
  model: string;
  delta: {
    content?: string;
  };
  finishReason: "stop" | "length" | "content_filter" | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIProvider {
  readonly name: string;
  complete(config: AIRequestConfig): Promise<AIResponse>;
  stream(config: AIRequestConfig): AsyncGenerator<AIStreamChunk, void, unknown>;
}

export interface AIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

/** A value or a function that returns a value (resolved at query time). */
export type Lazy<T> = T | (() => T);
