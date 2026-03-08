import { OpenRouter } from "@openrouter/sdk";
import type {
  AIProvider,
  AIProviderConfig,
  AIRequestConfig,
  AIResponse,
  AIStreamChunk,
  JsonToolCall,
} from "./types.ts";

export class OpenRouterProvider implements AIProvider {
  readonly name = "openrouter";
  private client: OpenRouter;

  constructor(config: AIProviderConfig) {
    this.client = new OpenRouter({ apiKey: config.apiKey });
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    const response = await this.client.chat.send({
      chatGenerationParams: {
        model: config.model,
        messages: config.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
        ...(config.topP !== undefined && { topP: config.topP }),
        ...(config.frequencyPenalty !== undefined && { frequencyPenalty: config.frequencyPenalty }),
        ...(config.presencePenalty !== undefined && { presencePenalty: config.presencePenalty }),
        ...(config.stop !== undefined && { stop: config.stop }),
        ...(config.seed !== undefined && { seed: config.seed }),
        ...(config.provider && { provider: config.provider }),
        ...(config.tools && { tools: config.tools }),
        ...(config.toolChoice !== undefined && { tool_choice: config.toolChoice }),
      },
    });

    const choice = response.choices?.[0];
    const toolCalls = this.extractToolCalls(choice?.message);

    return {
      id: response.id,
      model: response.model,
      content: typeof choice?.message?.content === "string" ? choice.message.content : null,
      finishReason: this.parseFinishReason(choice?.finishReason ?? null),
      ...(toolCalls.length > 0 && { toolCalls }),
      usage: response.usage
        ? {
            promptTokens: response.usage.promptTokens,
            completionTokens: response.usage.completionTokens,
            totalTokens: response.usage.totalTokens,
          }
        : undefined,
    };
  }

  async *stream(config: AIRequestConfig): AsyncGenerator<AIStreamChunk, void, unknown> {
    const response = await this.client.chat.send({
      chatGenerationParams: {
        model: config.model,
        messages: config.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
        ...(config.topP !== undefined && { topP: config.topP }),
        ...(config.frequencyPenalty !== undefined && { frequencyPenalty: config.frequencyPenalty }),
        ...(config.presencePenalty !== undefined && { presencePenalty: config.presencePenalty }),
        ...(config.stop !== undefined && { stop: config.stop }),
        ...(config.seed !== undefined && { seed: config.seed }),
        ...(config.provider && { provider: config.provider }),
        ...(config.tools && { tools: config.tools }),
        ...(config.toolChoice !== undefined && { tool_choice: config.toolChoice }),
      },
    });

    for await (const chunk of response) {
      const choice = chunk.choices?.[0];
      const toolCalls = this.extractToolCalls(choice?.delta);

      yield {
        id: chunk.id,
        model: chunk.model,
        delta: {
          content: choice?.delta?.content ?? undefined,
          ...(toolCalls.length > 0 && { toolCalls }),
        },
        finishReason: this.parseFinishReason(
          typeof choice?.finishReason === "string" ? choice.finishReason : null
        ),
        ...(chunk.usage && {
          usage: {
            promptTokens: chunk.usage.promptTokens,
            completionTokens: chunk.usage.completionTokens,
            totalTokens: chunk.usage.totalTokens,
          },
        }),
      };
    }
  }

  private extractToolCalls(messageOrDelta: any): JsonToolCall[] {
    if (!messageOrDelta?.tool_calls) return [];
    const raw = messageOrDelta.tool_calls;
    if (!Array.isArray(raw)) return [];

    return raw.map((tc: any) => ({
      id: tc.id ?? "",
      type: "function" as const,
      function: {
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      },
    }));
  }

  private parseFinishReason(reason: string | null): AIResponse["finishReason"] {
    switch (reason) {
      case "stop": return "stop";
      case "length": return "length";
      case "content_filter": return "content_filter";
      case "tool_calls": return "tool_calls";
      default: return null;
    }
  }
}
