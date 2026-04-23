/**
 * Shared test helpers: stub AI provider, layer factories, and a small
 * `runTest` wrapper that hides the `Effect.scoped + Effect.runPromise`
 * boilerplate so test bodies read like straight Effects.
 */

import { Effect, Layer, Stream } from "effect"
import type { JsonToolCall } from "@hypen-space/gloop-loop"
import { AIProvider, type AIProviderImpl } from "../src/index.js"

// ----------------------------------------------------------------------------
// Scripted responses
// ----------------------------------------------------------------------------

export interface ScriptedResponse {
  readonly chunks: ReadonlyArray<string>
  readonly toolCalls?: ReadonlyArray<JsonToolCall>
  /**
   * If set, the stream fails *after* yielding this many chunks.
   * Used to simulate mid-stream cancellation observation.
   */
  readonly chunksThenError?: number
  /** Artificial delay per chunk for timing-dependent tests. */
  readonly chunkDelayMillis?: number
}

export interface StubOptions {
  readonly script: ReadonlyArray<ScriptedResponse>
  /** If true, record every request for assertion. */
  readonly record?: boolean
}

export interface StubProvider extends AIProviderImpl {
  readonly callCount: () => number
  readonly calls: () => ReadonlyArray<{ model: string }>
}

/**
 * Build a scripted AIProvider. Each `send`/`stream` consumes the next
 * element of `script`; if exhausted, replays the last.
 */
export const makeStubProvider = (opts: StubOptions): StubProvider => {
  let index = 0
  const calls: Array<{ model: string }> = []

  const next = (): ScriptedResponse => {
    const item = opts.script[Math.min(index, opts.script.length - 1)]
    index += 1
    return (
      item ?? {
        chunks: [""],
        toolCalls: [],
      }
    )
  }

  return {
    name: "stub",
    complete: (req) => {
      const r = next()
      if (opts.record !== false) calls.push({ model: req.model })
      return Effect.succeed({
        id: `stub_${index}`,
        model: req.model,
        content: r.chunks.join(""),
        finishReason: (r.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop",
        toolCalls: r.toolCalls ? [...r.toolCalls] : undefined,
      })
    },
    stream: (req) => {
      const r = next()
      if (opts.record !== false) calls.push({ model: req.model })
      const delay = r.chunkDelayMillis ?? 0
      const chunkStream = Stream.fromIterable(r.chunks).pipe(
        delay > 0
          ? Stream.mapEffect((c) =>
              Effect.sleep(`${delay} millis`).pipe(Effect.as(c)),
            )
          : (s) => s,
      )
      return {
        chunks: chunkStream,
        result: Effect.succeed({
          id: `stub_${index}`,
          model: req.model,
          content: r.chunks.join(""),
          finishReason: (r.toolCalls?.length ?? 0) > 0
            ? "tool_calls"
            : "stop",
          toolCalls: r.toolCalls ? [...r.toolCalls] : undefined,
        }),
        cancel: Effect.void,
      }
    },
    callCount: () => index,
    calls: () => [...calls],
  }
}

// ----------------------------------------------------------------------------
// Layer factories
// ----------------------------------------------------------------------------

export const StubProviderLayer = (script: ReadonlyArray<ScriptedResponse>) =>
  Layer.succeed(AIProvider, makeStubProvider({ script }))

// ----------------------------------------------------------------------------
// Test runner
// ----------------------------------------------------------------------------

export const runTest = <A, E>(
  program: Effect.Effect<A, E, AIProvider>,
  layer: Layer.Layer<AIProvider> = StubProviderLayer([{ chunks: ["ok"] }]),
): Promise<A> =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)))
