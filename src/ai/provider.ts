import { OpenRouter, fromChatMessages, tool } from "@openrouter/sdk";
import { z } from "zod";
import type {
  AIProvider,
  AIProviderConfig,
  AIRequestConfig,
  AIResponse,
  JsonTool,
  JsonToolCall,
  StreamResult,
} from "./types.ts";

/** Convert our JsonTool definitions to SDK ManualTool objects for callModel() */
function toSdkTools(jsonTools: JsonTool[]) {
  return jsonTools.map((jt) => {
    const shape: Record<string, z.ZodString> = {};
    for (const [name, param] of Object.entries(jt.function.parameters.properties)) {
      shape[name] = z.string().describe(param.description ?? "");
    }
    return tool({
      name: jt.function.name,
      description: jt.function.description,
      inputSchema: z.object(shape),
      execute: false as const,
    });
  });
}

export class OpenRouterProvider implements AIProvider {
  readonly name = "openrouter";
  private client: OpenRouter;

  constructor(config: AIProviderConfig) {
    this.client = new OpenRouter({ apiKey: config.apiKey });
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    const sdkTools = config.tools ? toSdkTools(config.tools) : undefined;
    const input = fromChatMessages(
      config.messages.map((m) => ({ role: m.role, content: m.content }))
    );

    const result = this.client.callModel({
      model: config.model,
      input,
      ...(sdkTools?.length && { tools: sdkTools }),
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      ...(config.maxTokens !== undefined && { maxOutputTokens: config.maxTokens }),
      ...(config.topP !== undefined && { topP: config.topP }),
      ...(config.frequencyPenalty !== undefined && { frequencyPenalty: config.frequencyPenalty }),
      ...(config.presencePenalty !== undefined && { presencePenalty: config.presencePenalty }),
      ...(config.provider && { provider: config.provider }),
      ...(config.toolChoice !== undefined && { toolChoice: config.toolChoice }),
    });

    const [text, response] = await Promise.all([
      result.getText(),
      result.getResponse(),
    ]);

    const toolCalls = extractToolCalls(response.output ?? []);

    return {
      id: response.id ?? "",
      model: response.model ?? config.model,
      content: text || null,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(response.usage && {
        usage: {
          promptTokens: response.usage.inputTokens ?? 0,
          completionTokens: response.usage.outputTokens ?? 0,
          totalTokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
        },
      }),
    };
  }

  stream(config: AIRequestConfig): StreamResult {
    const sdkTools = config.tools ? toSdkTools(config.tools) : undefined;
    const input = fromChatMessages(
      config.messages.map((m) => ({ role: m.role, content: m.content }))
    );

    const result = this.client.callModel({
      model: config.model,
      input,
      ...(sdkTools?.length && { tools: sdkTools }),
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      ...(config.maxTokens !== undefined && { maxOutputTokens: config.maxTokens }),
      ...(config.topP !== undefined && { topP: config.topP }),
      ...(config.frequencyPenalty !== undefined && { frequencyPenalty: config.frequencyPenalty }),
      ...(config.presencePenalty !== undefined && { presencePenalty: config.presencePenalty }),
      ...(config.provider && { provider: config.provider }),
      ...(config.toolChoice !== undefined && { toolChoice: config.toolChoice }),
    });

    const textStream = result.getTextStream();

    // Tool calls are extracted from the final response after streaming completes
    const toolCalls = result.getResponse().then((response) =>
      extractToolCalls(response.output ?? [])
    );

    return {
      textStream,
      toolCalls,
      cancel: () => result.cancel(),
    };
  }
}

/** Extract JsonToolCall[] from response output items */
function extractToolCalls(output: unknown[]): JsonToolCall[] {
  const calls: JsonToolCall[] = [];
  for (const item of output) {
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      (item as { type: string }).type === "function_call" &&
      "name" in item &&
      "arguments" in item &&
      "callId" in item
    ) {
      const fc = item as { name: string; arguments: string; callId: string };
      calls.push({
        id: fc.callId,
        type: "function",
        function: {
          name: fc.name,
          arguments: fc.arguments,
        },
      });
    }
  }
  return calls;
}
