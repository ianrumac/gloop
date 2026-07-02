/**
 * Native tool-call history + loop guards.
 *
 * Mirrors gloop-loop's regression tests for the review findings:
 *   - assistant toolCalls recorded in history (model remembers acting)
 *   - tool results recorded as role:"tool" messages, not user text
 *   - maxIterations stops a runaway tool loop (opt-in)
 *   - llmIdleTimeoutMs cancels a hung stream
 */

import { describe, expect, it } from "bun:test"
import { Effect, Either } from "effect"
import { Agent, type Tool } from "../src/index.js"
import { runTest, StubProviderLayer } from "./helpers.js"

const echoTool: Tool<never, never> = {
  name: "Echo",
  description: "Echo back the input",
  arguments: [{ name: "text", description: "text to echo" }],
  execute: (args) => Effect.succeed(`echo: ${args.text ?? ""}`),
}

const echoCall = (id: string, text: string) => ({
  id,
  type: "function" as const,
  function: { name: "Echo", arguments: JSON.stringify({ text }) },
})

describe("native tool-call history", () => {
  it("records assistant toolCalls and role:tool responses in history", async () => {
    const layer = StubProviderLayer([
      { chunks: ["calling echo"], toolCalls: [echoCall("c1", "hi")] },
      { chunks: ["done."] },
    ])

    const history = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          tools: [echoTool],
        })
        yield* agent.sendSync("go")
        const h = yield* agent.conversation.getHistory
        yield* agent.stop
        return h
      }),
      layer,
    )

    // [user, assistant(text+toolCalls), tool, assistant(text)]
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(history[1]?.toolCalls?.length).toBe(1)
    expect(history[1]?.toolCalls?.[0]?.id).toBe("c1")
    expect(history[2]?.toolCallId).toBe("c1")
    expect(history[2]?.content).toBe("echo: hi")
    // No synthetic user message carrying <tool_result>.
    expect(
      history.some((m) => m.role === "user" && m.content.includes("<tool_result")),
    ).toBe(false)
  })

  it("maxIterations stops a runaway tool loop", async () => {
    // The stub replays its last entry forever — a permanent tool-call loop.
    const layer = StubProviderLayer([
      { chunks: [""], toolCalls: [echoCall("c1", "again")] },
    ])

    const outcome = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          tools: [echoTool],
          maxIterations: 5,
        })
        const result = yield* Effect.either(agent.sendSync("loop forever"))
        yield* agent.stop
        return result
      }),
      layer,
    )

    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) {
      expect(String(outcome.left)).toContain("exceeded 5 LLM calls")
    }
  })

  it("llmIdleTimeoutMs fails a stream that stalls", async () => {
    const layer = StubProviderLayer([
      { chunks: ["a", "b"], chunkDelayMillis: 200 },
    ])

    const outcome = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          llmIdleTimeoutMs: 20,
        })
        const result = yield* Effect.either(agent.sendSync("hang"))
        yield* agent.stop
        return result
      }),
      layer,
    )

    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) {
      expect(String(outcome.left)).toContain("no output for 20ms")
    }
  })
})
