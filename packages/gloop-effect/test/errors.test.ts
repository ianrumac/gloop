/**
 * Error-path tests: provider failure → Error/Fatal event, sendSync rejection.
 */

import { describe, expect, it } from "bun:test"
import { Effect, Either, Fiber, Layer, Stream } from "effect"
import {
  Agent,
  AIProvider,
  AIProviderError,
  FatalAgentError,
  type AgentEvent,
  type AIProviderImpl,
} from "../src/index.js"
import { runTest } from "./helpers.js"

// Provider that always fails.
const failingProvider = (failure: AIProviderError): AIProviderImpl => ({
  name: "failing-stub",
  complete: () => Effect.fail(failure),
  stream: () => ({
    chunks: Stream.fail(failure),
    result: Effect.fail(failure),
    cancel: Effect.void,
  }),
})

const FailingLayer = (error: AIProviderError) =>
  Layer.succeed(AIProvider, failingProvider(error))

describe("Agent — error paths", () => {
  it("emits an Error event and rejects sendSync on provider failure", async () => {
    const err = new AIProviderError({
      message: "boom",
      op: "stream",
      model: "stub",
      provider: "failing-stub",
    })

    const { sendResult, events } = await runTest(
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
        const sendResult = yield* Effect.either(agent.sendSync("hi"))
        yield* Fiber.await(listener)
        return { sendResult, events: collected }
      }),
      FailingLayer(err),
    )

    expect(Either.isLeft(sendResult)).toBe(true)
    if (Either.isLeft(sendResult)) {
      expect(sendResult.left).toBeInstanceOf(AIProviderError)
      expect((sendResult.left as AIProviderError).op).toBe("stream")
    }

    const errEvent = events.find((e) => e._tag === "Error")
    expect(errEvent).toBeDefined()
    if (errEvent && errEvent._tag === "Error") {
      expect(errEvent.error._tag).toBe("AIProviderError")
    }
  })

  it("escalates to a Fatal event when isFatal returns true", async () => {
    const err = new AIProviderError({
      message: "catastrophe",
      op: "complete",
    })

    const events = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          isFatal: (e) => e._tag === "AIProviderError",
        })
        const collected: AgentEvent[] = []
        const listener = yield* Effect.fork(
          agent.events.pipe(
            Stream.takeUntil(
              (e) => e._tag === "Fatal" || e._tag === "TurnEnd",
            ),
            Stream.runForEach((e) =>
              Effect.sync(() => {
                collected.push(e)
              }),
            ),
          ),
        )
        yield* Effect.either(agent.sendSync("hi"))
        yield* Fiber.await(listener)
        return collected
      }),
      FailingLayer(err),
    )

    const tags = events.map((e) => e._tag)
    expect(tags).toContain("Fatal")
    expect(tags).not.toContain("Error")
  })

  it("the enriched error still satisfies the FatalAgentError schema shape", () => {
    const fatal = new FatalAgentError({
      message: "teardown",
      phase: "turn",
    })
    expect(fatal._tag).toBe("FatalAgentError")
    expect(fatal.phase).toBe("turn")
  })
})
