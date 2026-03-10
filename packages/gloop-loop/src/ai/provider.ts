import { OpenRouter } from "@openrouter/sdk";
import type {
  AIProvider,
  AIProviderConfig,
  AIRequestConfig,
  AIResponse,
  JsonTool,
  JsonToolCall,
  StreamResult,
} from "./types.ts";

export class OpenRouterProvider implements AIProvider {
  readonly name = "openrouter";
  private client: OpenRouter;
  private httpReferer?: string;
  private xTitle?: string;

  constructor(config: AIProviderConfig) {
    this.client = new OpenRouter({
      apiKey: config.apiKey,
      ...(config.httpReferer && { httpReferer: config.httpReferer }),
      ...(config.xTitle && { xTitle: config.xTitle }),
    });
    this.httpReferer = config.httpReferer;
    this.xTitle = config.xTitle;
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    const response: any = await this.client.chat.send({
      ...(this.httpReferer && { httpReferer: this.httpReferer }),
      ...(this.xTitle && { xTitle: this.xTitle }),
      chatGenerationParams: buildChatParams(config),
    });

    const choice = response.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : null;
    const toolCalls = extractChatToolCalls(choice?.message?.toolCalls);

    return {
      id: response.id ?? "",
      model: response.model ?? config.model,
      content: text,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(response.usage && {
        usage: {
          promptTokens: response.usage.promptTokens ?? 0,
          completionTokens: response.usage.completionTokens ?? 0,
          totalTokens: response.usage.totalTokens ?? 0,
        },
      }),
    };
  }

  stream(config: AIRequestConfig): StreamResult {
    // Request a streaming response from the Chat Completions API
    const streamPromise: Promise<AsyncIterable<any>> = this.client.chat.send({
      ...(this.httpReferer && { httpReferer: this.httpReferer }),
      ...(this.xTitle && { xTitle: this.xTitle }),
      chatGenerationParams: { ...buildChatParams(config), stream: true },
    }) as any;

    // Accumulate tool call deltas across chunks
    const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>();
    let resolveToolCalls: (calls: JsonToolCall[]) => void;
    const toolCallsPromise = new Promise<JsonToolCall[]>((resolve) => {
      resolveToolCalls = resolve;
    });

    // Get the underlying async iterator once and reuse across next() calls
    let iteratorPromise: Promise<AsyncIterator<any>> | null = null;
    function getIterator() {
      if (!iteratorPromise) {
        iteratorPromise = streamPromise.then((es) =>
          (es as any)[Symbol.asyncIterator]()
        );
      }
      return iteratorPromise;
    }

    function finalizeToolCalls() {
      const calls: JsonToolCall[] = [];
      for (const [, tc] of toolCallAcc) {
        if (tc.name) {
          calls.push({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          });
        }
      }
      resolveToolCalls(calls);
    }

    const textStream: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() { return textStream; },
      async next(): Promise<IteratorResult<string>> {
        const iter = await getIterator();

        while (true) {
          const result = await iter.next();
          if (result.done) {
            finalizeToolCalls();
            return { value: undefined as any, done: true };
          }

          const chunk = result.value;
          const choice = chunk?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;

          // Accumulate tool call deltas
          if (delta?.toolCalls) {
            for (const tc of delta.toolCalls) {
              const idx = tc.index ?? 0;
              const existing = toolCallAcc.get(idx);
              if (!existing) {
                toolCallAcc.set(idx, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              }
            }
          }

          // Yield text content
          const text = delta?.content;
          if (typeof text === "string" && text.length > 0) {
            return { value: text, done: false };
          }
        }
      },
      async return() {
        finalizeToolCalls();
        return { value: undefined as any, done: true };
      },
      async throw(e) { throw e; },
    };

    return {
      textStream,
      toolCalls: toolCallsPromise,
      cancel: async () => {
        // EventStream extends ReadableStream, cancel it if possible
        const es = await streamPromise;
        if (es && typeof (es as any).cancel === "function") {
          await (es as any).cancel();
        }
      },
    };
  }
}

/** Build ChatGenerationParams from AIRequestConfig */
function buildChatParams(config: AIRequestConfig) {
  return {
    model: config.model,
    messages: config.messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    })),
    ...(config.tools?.length && { tools: toSdkTools(config.tools) }),
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
    ...(config.topP !== undefined && { topP: config.topP }),
    ...(config.frequencyPenalty !== undefined && { frequencyPenalty: config.frequencyPenalty }),
    ...(config.presencePenalty !== undefined && { presencePenalty: config.presencePenalty }),
    ...(config.provider && { provider: config.provider as any }),
    ...(config.toolChoice !== undefined && { toolChoice: config.toolChoice as any }),
  };
}

/** Convert JsonTool definitions to SDK ToolDefinitionJson format */
function toSdkTools(jsonTools: JsonTool[]) {
  return jsonTools.map((jt) => ({
    type: "function" as const,
    function: {
      name: jt.function.name,
      description: jt.function.description,
      parameters: jt.function.parameters as Record<string, any>,
    },
  }));
}

/** Extract JsonToolCall[] from ChatMessageToolCall[] */
function extractChatToolCalls(
  toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
): JsonToolCall[] {
  if (!toolCalls?.length) return [];
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));
}
