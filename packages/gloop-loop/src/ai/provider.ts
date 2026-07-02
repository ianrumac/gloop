import { OpenRouter } from "@openrouter/sdk";
import type {
  AIProvider,
  AIProviderConfig,
  AIRequestConfig,
  AIResponse,
  FinishReason,
  JsonTool,
  JsonToolCall,
  StreamResult,
} from "./types.ts";

const FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop", "length", "content_filter", "tool_calls",
]);

function coerceFinishReason(raw: unknown): FinishReason {
  return typeof raw === "string" && FINISH_REASONS.has(raw)
    ? (raw as FinishReason)
    : null;
}

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

    const apiFinish = coerceFinishReason(choice?.finishReason);
    return {
      id: response.id ?? "",
      model: response.model ?? config.model,
      content: text,
      finishReason: apiFinish ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
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

    // Capture finish reason from the final chunk(s). Providers usually send it
    // on the last delta, sometimes split across two chunks — keep the latest.
    let lastFinishReason: FinishReason = null;
    let resolveFinishReason: (r: FinishReason) => void;
    const finishReasonPromise = new Promise<FinishReason>((resolve) => {
      resolveFinishReason = resolve;
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

    function finalize() {
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
      // Synthesize tool_calls if the provider didn't explicitly send a finish
      // reason but we accumulated tool deltas — keeps semantics aligned with
      // the non-streaming path's fallback.
      const finish = lastFinishReason ?? (calls.length > 0 ? "tool_calls" : null);
      resolveFinishReason(finish);
    }

    const textStream: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() { return textStream; },
      async next(): Promise<IteratorResult<string>> {
        const iter = await getIterator();

        while (true) {
          const result = await iter.next();
          if (result.done) {
            finalize();
            return { value: undefined as any, done: true };
          }

          const chunk = result.value;
          const choice = chunk?.choices?.[0];
          if (!choice) continue;
          const reason = coerceFinishReason(choice.finishReason);
          if (reason !== null) lastFinishReason = reason;
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
        finalize();
        return { value: undefined as any, done: true };
      },
      async throw(e) { throw e; },
    };

    return {
      textStream,
      toolCalls: toolCallsPromise,
      finishReason: finishReasonPromise,
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
    messages: config.messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool" as const, content: m.content, toolCallId: m.toolCallId ?? "" };
      }
      return {
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
        ...(m.role === "assistant" && m.toolCalls?.length && {
          toolCalls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        }),
      };
    }),
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
