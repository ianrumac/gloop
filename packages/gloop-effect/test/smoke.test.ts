/**
 * Smoke tests — happy-path agent lifecycle with a stub provider.
 */

import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { Agent, type AgentEvent } from "../src/index.js"
import { runTest, StubProviderLayer } from "./helpers.js"

describe("Agent — smoke", () => {
  it("drains a one-message turn end-to-end", async () => {
    const events: AgentEvent[] = []

    const program = Effect.gen(function* () {
      const agent = yield* Agent.make({
        model: "stub",
        system: "You are a test bot.",
      })

      // Fork a listener that stops at the first TurnEnd.
      const listener = yield* Effect.fork(
        agent.events.pipe(
          Stream.takeUntil((e) => e._tag === "TurnEnd"),
          Stream.runForEach((e) =>
            Effect.sync(() => {
              events.push(e)
            }),
          ),
        ),
      )

      yield* agent.sendSync("hello")
      yield* Fiber.await(listener)
    })

    await runTest(program, StubProviderLayer([{ chunks: ["Hello, ", "world!"] }]))

    const tags = events.map((e) => e._tag)
    expect(tags).toContain("StreamChunk")
    expect(tags).toContain("StreamDone")
    expect(tags).toContain("TurnEnd")

    const text = events
      .filter((e): e is Extract<AgentEvent, { _tag: "StreamChunk" }> =>
        e._tag === "StreamChunk",
      )
      .map((c) => c.text)
      .join("")
    expect(text).toBe("Hello, world!")
  })

  it("reaches pending=0 after sendSync resolves", async () => {
    const pending = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({ model: "stub", system: "t" })
        yield* agent.sendSync("hi")
        return yield* agent.pending
      }),
    )
    expect(pending).toBe(0)
  })
})
