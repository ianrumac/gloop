/**
 * gloop-effect/AIProvider — Effect-native provider interface.
 *
 * Wraps the callable surface of an LLM provider as an Effect service.
 * `complete` returns a plain Effect; `stream` returns a Stream of chunks
 * plus an Effect for the finalized response (including tool calls).
 *
 * Concrete providers (OpenRouter, Anthropic, local) are registered by
 * providing a layer at the application root.
 */

import { Context, Effect, Stream } from "effect"
import type {
  AIRequestConfig,
  AIResponse,
  JsonToolCall,
} from "@hypen-space/gloop-loop"
import type { AIProviderError } from "./Errors.js"

// ============================================================================
// Stream shape
// ============================================================================

/**
 * A streaming response. `chunks` yields text deltas as they arrive; `result`
 * resolves once the stream is complete with tool calls and finish reason.
 *
 * Consumers typically drain `chunks` (to emit `stream_chunk` events) and
 * then await `result` to pick up any tool calls.
 */
export interface StreamResponse {
  readonly chunks: Stream.Stream<string, AIProviderError>
  readonly result: Effect.Effect<AIResponse, AIProviderError>
  /** Cancel an in-flight stream. Safe to call after the stream completes. */
  readonly cancel: Effect.Effect<void>
}

// ============================================================================
// Service
// ============================================================================

export interface AIProviderImpl {
  readonly name: string
  readonly complete: (
    config: AIRequestConfig,
  ) => Effect.Effect<AIResponse, AIProviderError>
  readonly stream: (config: AIRequestConfig) => StreamResponse
}

export class AIProvider extends Context.Tag("gloop/AIProvider")<
  AIProvider,
  AIProviderImpl
>() {}

// ============================================================================
// Helpers for consumers
// ============================================================================

/**
 * Drain a `StreamResponse`: emit each chunk through `onChunk`, then resolve
 * with the final `AIResponse`. Interruption cancels the underlying stream.
 */
export const consumeStream = (
  response: StreamResponse,
  onChunk: (text: string) => Effect.Effect<void>,
): Effect.Effect<AIResponse, AIProviderError> =>
  Effect.gen(function* () {
    yield* response.chunks.pipe(Stream.runForEach(onChunk))
    return yield* response.result
  }).pipe(
    Effect.onInterrupt(() => response.cancel),
  )

/** Extract just the tool calls from a completed AIResponse. */
export const toolCallsOf = (response: AIResponse): ReadonlyArray<JsonToolCall> =>
  response.toolCalls ?? []
