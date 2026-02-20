export type {
  AIProvider,
  AIProviderConfig,
  AIRequestConfig,
  AIResponse,
  AIStreamChunk,
  Message,
  MessageRole,
  ProviderRouting,
  Lazy,
} from "./types.ts";

export { AI, AIBuilder, AIConversation } from "./builder.ts";
export { OpenRouterProvider } from "./provider.ts";

import { AI } from "./builder.ts";
import { OpenRouterProvider } from "./provider.ts";

export interface AIConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export function createAI(config: AIConfig): AI {
  const provider = new OpenRouterProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
  return new AI(provider, config.defaultModel);
}
