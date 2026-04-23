/**
 * Lifecycle tests: interrupt, stop, pending-state correctness.
 */

import { describe, expect, it } from "bun:test"
import { Effect, Either, Fiber, Stream } from "effect"
import {
  Agent,
  AgentInterruptedError,
  type AgentEvent,
} from "../src/index.js"
import { runTest, StubProviderLayer } from "./helpers.js"

describe("Agent.interrupt", () => {
  it("fails sendSync with AgentInterruptedError when the turn is interrupted", async () => {
    // Stream that takes its time so we can interrupt mid-flight.
    const layer = StubProviderLayer([
      { chunks: ["a", "b", "c", "d", "e"], chunkDelayMillis: 50 },
    ])

    const result = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({ model: "stub", system: "t" })
        // Fork sendSync and schedule an interrupt shortly after.
        const sendFiber = yield* Effect.fork(
          Effect.either(agent.sendSync("hi")),
        )
        yield* Effect.sleep("60 millis")
        yield* agent.interrupt
        return yield* Fiber.join(sendFiber)
      }),
      layer,
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(AgentInterruptedError)
    }
  })

  it("emits an Interrupted event on interrupt", async () => {
    const layer = StubProviderLayer([
      { chunks: ["x", "y"], chunkDelayMillis: 50 },
    ])

    const events = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({ model: "stub", system: "t" })
        const collected: AgentEvent[] = []
        const listener = yield* Effect.fork(
          agent.events.pipe(
            Stream.takeUntil((e) => e._tag === "TurnEnd"),
            Stream.runForEach((e) =>
              Effect.sync(() => {
                collected.push(e)
              }),
            ),
          ),
        )

        const sendFiber = yield* Effect.fork(
          Effect.either(agent.sendSync("hi")),
        )
        yield* Effect.sleep("60 millis")
        yield* agent.interrupt
        yield* Fiber.join(sendFiber)
        yield* Fiber.await(listener)
        return collected
      }),
      layer,
    )

    expect(events.map((e) => e._tag)).toContain("Interrupted")
  })
})

describe("Agent.stop", () => {
  it("drains the inbox and exits cleanly", async () => {
    const layer = StubProviderLayer([{ chunks: ["ok"] }])

    const finalPending = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({ model: "stub", system: "t" })
        yield* agent.send("pending 1")
        yield* agent.send("pending 2")
        yield* agent.send("pending 3")
        yield* agent.stop
        return yield* agent.pending
      }),
      layer,
    )

    expect(finalPending).toBe(0)
  })
})

describe("Agent.awaitIdle", () => {
  it("resolves after all queued messages are drained", async () => {
    const layer = StubProviderLayer([
      { chunks: ["a"] },
      { chunks: ["b"] },
      { chunks: ["c"] },
    ])

    const pendingAfterIdle = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({ model: "stub", system: "t" })
        yield* agent.send("one")
        yield* agent.send("two")
        yield* agent.send("three")
        yield* agent.awaitIdle
        return yield* agent.pending
      }),
      layer,
    )

    expect(pendingAfterIdle).toBe(0)
  })
})
