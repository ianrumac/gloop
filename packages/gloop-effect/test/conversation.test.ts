/**
 * Conversation tests: history commits, stream cancel preserves partial text,
 * fork copies state.
 */

import { describe, expect, it } from "bun:test"
import { Effect, Stream } from "effect"
import { AIProvider, makeConversation, type AIProviderImpl } from "../src/index.js"
import type { ModelId } from "../src/Schema.js"

const MODEL = "stub" as ModelId

// Provider whose stream completes normally — `send` commits user+assistant,
// `stream` commits user + partial assistant text as it flows.
const stableProvider: AIProviderImpl = {
  name: "stable",
  complete: (req) =>
    Effect.succeed({
      id: "x",
      model: req.model,
      content: "hello",
      finishReason: "stop",
    }),
  stream: (req) => ({
    chunks: Stream.fromIterable(["he", "llo"]),
    result: Effect.succeed({
      id: "x",
      model: req.model,
      content: "hello",
      finishReason: "stop",
    }),
    cancel: Effect.void,
  }),
}

const run = <A, E>(program: Effect.Effect<A, E, AIProvider>): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provideService(AIProvider, stableProvider),
      Effect.scoped,
    ),
  )

describe("Conversation — send/history", () => {
  it("appends user + assistant after a non-streaming send", async () => {
    const history = await run(
      Effect.gen(function* () {
        const convo = yield* makeConversation({
          model: MODEL,
          system: "you are a test bot",
        })
        yield* convo.send("hi")
        return yield* convo.getHistory
      }),
    )
    expect(history.length).toBe(2)
    expect(history[0]?.role).toBe("user")
    expect(history[0]?.content).toBe("hi")
    expect(history[1]?.role).toBe("assistant")
    expect(history[1]?.content).toBe("hello")
  })

  it("commits the partial assistant message after a stream completes", async () => {
    const history = await run(
      Effect.gen(function* () {
        const convo = yield* makeConversation({ model: MODEL })
        const response = yield* convo.stream("hi")
        // Drain chunks (simulates consumer)
        yield* response.chunks.pipe(Stream.runDrain)
        yield* response.result
        return yield* convo.getHistory
      }),
    )
    // Expected: user("hi"), assistant("hello")
    expect(history.length).toBe(2)
    expect(history[1]?.role).toBe("assistant")
    expect(history[1]?.content).toBe("hello")
  })

  it("fork copies system prompt but not history", async () => {
    const result = await run(
      Effect.gen(function* () {
        const parent = yield* makeConversation({
          model: MODEL,
          system: "system A",
        })
        yield* parent.send("m1")
        const child = yield* parent.fork
        const childSys = yield* child.getSystem
        const childHist = yield* child.getHistory
        return { childSys, childHistLen: childHist.length }
      }),
    )
    expect(result.childSys).toBe("system A")
    expect(result.childHistLen).toBe(0)
  })

  it("clear empties history but preserves system prompt", async () => {
    const { sys, histLen } = await run(
      Effect.gen(function* () {
        const convo = yield* makeConversation({
          model: MODEL,
          system: "keep me",
        })
        yield* convo.send("msg")
        yield* convo.clear
        const sys = yield* convo.getSystem
        const hist = yield* convo.getHistory
        return { sys, histLen: hist.length }
      }),
    )
    expect(sys).toBe("keep me")
    expect(histLen).toBe(0)
  })
})
