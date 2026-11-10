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
  Usage,
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
      // Any OpenAI-compatible chat-completions endpoint (a local model, a
      // proxy, a test double) — requests go to `${baseUrl}/chat/completions`.
      ...(config.baseUrl && { serverURL: config.baseUrl }),
      ...(config.httpReferer && { httpReferer: config.httpReferer }),
      ...(config.xTitle && { xTitle: config.xTitle }),
    });
    this.httpReferer = config.httpReferer;
    this.xTitle = config.xTitle;
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    const response: any = await this.client.chat.send(
      {
        ...(this.httpReferer && { httpReferer: this.httpReferer }),
        ...(this.xTitle && { xTitle: this.xTitle }),
        chatGenerationParams: buildChatParams(config),
      },
      config.signal ? { signal: config.signal } : undefined,
    );

    const choice = response.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : null;
    const toolCalls = extractChatToolCalls(choice?.message?.toolCalls);

    const apiFinish = coerceFinishReason(choice?.finishReason);
    const usage = toUsage(response.usage);
    return {
      id: response.id ?? "",
      model: response.model ?? config.model,
      content: text,
      finishReason: apiFinish ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(usage && { usage }),
    };
  }

  stream(config: AIRequestConfig): StreamResult {
    // One controller per request: `cancel()` aborts it, which also unblocks
    // a request the server never answered.  A caller's signal is linked in.
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (config.signal?.aborted) controller.abort();
    else config.signal?.addEventListener("abort", onCallerAbort, { once: true });

    // Request a streaming response from the Chat Completions API
    const streamPromise: Promise<AsyncIterable<any>> = this.client.chat.send(
      {
        ...(this.httpReferer && { httpReferer: this.httpReferer }),
        ...(this.xTitle && { xTitle: this.xTitle }),
        chatGenerationParams: {
          ...buildChatParams(config),
          stream: true,
          // OpenRouter always reports usage; OpenAI-compatible servers only
          // put it on the final chunk when asked.
          streamOptions: { includeUsage: true },
        },
      },
      { signal: controller.signal },
    ) as any;
    // Errors surface through `textStream.next()`; this only keeps a request
    // that is cancelled before anyone iterates from becoming unhandled.
    streamPromise.catch(() => {});

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

    // Usage arrives on the last chunk (often one with no choices).
    let lastUsage: Usage | undefined;
    let resolveUsage: (u: Usage | undefined) => void;
    const usagePromise = new Promise<Usage | undefined>((resolve) => {
      resolveUsage = resolve;
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

    // Settle the side promises exactly once — on completion, error or
    // cancel — so nothing awaiting them can hang.
    let finalized = false;
    function finalize() {
      if (finalized) return;
      finalized = true;
      config.signal?.removeEventListener("abort", onCallerAbort);
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
      resolveUsage(lastUsage);
    }

    const textStream: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() { return textStream; },
      async next(): Promise<IteratorResult<string>> {
        try {
          const iter = await getIterator();
          const result = await iter.next();
          if (result.done) {
            finalize();
            return { value: undefined as any, done: true };
          }

          const chunk = result.value;
          const usage = toUsage(chunk?.usage);
          if (usage) lastUsage = usage;
          const choice = chunk?.choices?.[0];
          const reason = coerceFinishReason(choice?.finishReason);
          if (reason !== null) lastFinishReason = reason;
          const delta = choice?.delta;

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

          // Yield text content — or "" as a heartbeat for a chunk without
          // text (tool-call / reasoning deltas, usage), so an idle timeout
          // can tell an active stream from a silent one.
          const text = delta?.content;
          return { value: typeof text === "string" ? text : "", done: false };
        } catch (err) {
          finalize();
          throw err;
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
      usage: usagePromise,
      cancel: async () => {
        // Never await the request: a server that never answered would
        // block forever.  Aborting the fetch tears down the body stream too.
        controller.abort();
        finalize();
      },
    };
  }
}

/** Map the SDK's usage object onto `Usage`; undefined when absent. */
function toUsage(raw: any): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const cached = raw.promptTokensDetails?.cachedTokens;
  const reasoning = raw.completionTokensDetails?.reasoningTokens;
  return {
    promptTokens: raw.promptTokens ?? 0,
    completionTokens: raw.completionTokens ?? 0,
    totalTokens: raw.totalTokens ?? 0,
    ...(typeof cached === "number" && { cachedTokens: cached }),
    ...(typeof reasoning === "number" && { reasoningTokens: reasoning }),
  };
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
    ...(config.stop?.length && { stop: config.stop }),
    ...(config.seed !== undefined && { seed: config.seed }),
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
