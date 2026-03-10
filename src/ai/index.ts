export type {
  AIProvider,
  AIProviderConfig,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  Message,
  MessageRole,
  ProviderRouting,
  Lazy,
  JsonTool,
  JsonToolCall,
  JsonToolFunction,
  JsonToolParameter,
  ToolChoice,
} from "./types.ts";

export { AI, AIBuilder, AIConversation } from "./builder.ts";
export { OpenRouterProvider } from "@hypen-space/gloop-loop";

import { AI } from "./builder.ts";
import { OpenRouterProvider } from "@hypen-space/gloop-loop";

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
