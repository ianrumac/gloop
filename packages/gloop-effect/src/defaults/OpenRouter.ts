/**
 * Effect-native layer wrapping gloop-loop's OpenRouterProvider.
 *
 * The upstream provider is a plain class that returns Promises and an
 * async iterator; we adapt both to Effect + Stream shapes while preserving
 * cancellation semantics.
 */

import { Effect, Layer, Stream } from "effect"
import {
  OpenRouterProvider as LoopOpenRouterProvider,
  type AIProviderConfig,
  type AIRequestConfig,
  type AIResponse,
  type JsonToolCall,
} from "@hypen-space/gloop-loop"
import { AIProvider, type StreamResponse } from "../AIProvider.js"
import { AIProviderError } from "../Errors.js"

const PROVIDER_NAME = "openrouter"

const makeError =
  (op: "complete" | "stream", model: string) =>
  (e: unknown): AIProviderError =>
    new AIProviderError({
      op,
      model,
      provider: PROVIDER_NAME,
      message: e instanceof Error ? e.message : String(e),
      cause: e,
    })

const adaptStream = (
  underlying: ReturnType<LoopOpenRouterProvider["stream"]>,
  model: string,
): StreamResponse => {
  const toError = makeError("stream", model)

  // Accumulate text so `result` can materialize a complete AIResponse.
  const bufferState: { text: string } = { text: "" }

  const chunks = Stream.fromAsyncIterable(
    underlying.textStream,
    toError,
  ).pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        bufferState.text += chunk
      }),
    ),
    Stream.withSpan("OpenRouterProvider.stream.chunks", {
      attributes: { model },
    }),
  )

  const result: Effect.Effect<AIResponse, AIProviderError> = Effect.tryPromise(
    {
      try: () => underlying.toolCalls,
      catch: toError,
    },
  ).pipe(
    Effect.map((toolCalls: JsonToolCall[]): AIResponse => ({
      id: "",
      model,
      content: bufferState.text,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    })),
    Effect.withSpan("OpenRouterProvider.stream.result", {
      attributes: { model },
    }),
  )

  const cancel = Effect.promise(() => underlying.cancel().catch(() => {}))

  return { chunks, result, cancel }
}

/**
 * Layer providing `AIProvider` backed by OpenRouter.
 *
 * @example
 * ```ts
 * const MainLive = OpenRouterProviderLive({ apiKey: process.env.OPENROUTER_API_KEY! })
 * ```
 */
export const OpenRouterProviderLive = (
  config: AIProviderConfig,
): Layer.Layer<AIProvider> =>
  Layer.sync(AIProvider, () => {
    const provider = new LoopOpenRouterProvider(config)
    return {
      name: PROVIDER_NAME,
      complete: (req: AIRequestConfig) =>
        Effect.tryPromise({
          try: () => provider.complete(req),
          catch: makeError("complete", req.model),
        }).pipe(
          Effect.withSpan("OpenRouterProvider.complete", {
            attributes: { model: req.model },
          }),
        ),
      stream: (req: AIRequestConfig) =>
        adaptStream(provider.stream(req), req.model),
    }
  })
