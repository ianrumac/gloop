/**
 * Tool execution tests: registry lookup, execute, ToolStart/ToolDone pairing,
 * error → success:false result.
 */

import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Option, Stream } from "effect"
import {
  Agent,
  ToolExecutionError,
  type AgentEvent,
  type Tool,
} from "../src/index.js"
import { runTest, StubProviderLayer } from "./helpers.js"

const echoTool: Tool<never, never> = {
  name: "Echo",
  description: "Echo back the input",
  arguments: [{ name: "text", description: "text to echo" }],
  execute: (args) => Effect.succeed(`echo: ${args.text ?? ""}`),
}

const flakyTool: Tool<ToolExecutionError> = {
  name: "Flaky",
  description: "Always fails",
  arguments: [{ name: "x", description: "x" }],
  execute: () =>
    Effect.fail(
      new ToolExecutionError({
        name: "Flaky",
        message: "flaky failure",
      }),
    ),
}

const guardedTool: Tool<never, never> = {
  name: "Guarded",
  description: "Requires confirmation",
  arguments: [{ name: "cmd", description: "cmd" }],
  askPermission: (args) => Option.some(`Run: ${args.cmd}`),
  execute: (args) => Effect.succeed(`ran: ${args.cmd}`),
}

describe("Agent — tool execution", () => {
  it("executes a registered tool and emits matched ToolStart/ToolDone", async () => {
    const layer = StubProviderLayer([
      // First turn: the model "decides" to call Echo.
      {
        chunks: [""],
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "Echo",
              arguments: JSON.stringify({ text: "hello" }),
            },
          },
        ],
      },
      // Second turn (after tool results fed back): done.
      { chunks: ["done."] },
    ])

    const events = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          tools: [echoTool],
        })
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
        yield* agent.sendSync("call echo")
        yield* Fiber.await(listener)
        return collected
      }),
      layer,
    )

    const starts = events.filter((e) => e._tag === "ToolStart")
    const dones = events.filter((e) => e._tag === "ToolDone")

    expect(starts.length).toBe(1)
    expect(dones.length).toBe(1)
    if (starts[0]?._tag === "ToolStart" && dones[0]?._tag === "ToolDone") {
      expect(starts[0].name).toBe("Echo")
      expect(dones[0].name).toBe("Echo")
      expect(dones[0].ok).toBe(true)
      // IDs are stable across the pair.
      expect(starts[0].id).toBe(dones[0].id)
    }
  })

  it("folds a tool failure into a success:false ToolDone and keeps the turn alive", async () => {
    const layer = StubProviderLayer([
      {
        chunks: [""],
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "Flaky",
              arguments: JSON.stringify({ x: "y" }),
            },
          },
        ],
      },
      { chunks: ["moving on"] },
    ])

    const events = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          tools: [flakyTool],
        })
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
        yield* agent.sendSync("run flaky")
        yield* Fiber.await(listener)
        return collected
      }),
      layer,
    )

    const done = events.find((e) => e._tag === "ToolDone")
    expect(done).toBeDefined()
    if (done && done._tag === "ToolDone") {
      expect(done.ok).toBe(false)
      expect(done.output).toContain("flaky failure")
    }
    // The turn completed normally (no Error/Fatal).
    expect(events.find((e) => e._tag === "Error")).toBeUndefined()
    expect(events.find((e) => e._tag === "Fatal")).toBeUndefined()
  })

  it("prompts via confirm_request for a gated tool and runs when approved", async () => {
    const layer = StubProviderLayer([
      {
        chunks: [""],
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "Guarded",
              arguments: JSON.stringify({ cmd: "deploy" }),
            },
          },
        ],
      },
      { chunks: ["ok"] },
    ])

    const events = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          tools: [guardedTool],
        })

        // Listen + auto-approve confirm_request when it fires.
        const collected: AgentEvent[] = []
        const listener = yield* Effect.fork(
          agent.events.pipe(
            Stream.takeUntil((e) => e._tag === "TurnEnd"),
            Stream.runForEach((e) =>
              Effect.gen(function* () {
                collected.push(e)
                if (e._tag === "ConfirmRequest") {
                  yield* agent.respondToConfirm(e.id, true)
                }
              }),
            ),
          ),
        )

        yield* agent.sendSync("run guarded")
        yield* Fiber.await(listener)
        return collected
      }),
      layer,
    )

    const confirm = events.find((e) => e._tag === "ConfirmRequest")
    const done = events.find((e) => e._tag === "ToolDone")
    expect(confirm).toBeDefined()
    expect(done).toBeDefined()
    if (done && done._tag === "ToolDone") {
      expect(done.ok).toBe(true)
    }
  })

  it("denies a gated tool when respondToConfirm returns false", async () => {
    const layer = StubProviderLayer([
      {
        chunks: [""],
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "Guarded",
              arguments: JSON.stringify({ cmd: "nuke" }),
            },
          },
        ],
      },
      { chunks: ["denied"] },
    ])

    const events = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          tools: [guardedTool],
        })
        const collected: AgentEvent[] = []
        const listener = yield* Effect.fork(
          agent.events.pipe(
            Stream.takeUntil((e) => e._tag === "TurnEnd"),
            Stream.runForEach((e) =>
              Effect.gen(function* () {
                collected.push(e)
                if (e._tag === "ConfirmRequest") {
                  yield* agent.respondToConfirm(e.id, false)
                }
              }),
            ),
          ),
        )
        yield* agent.sendSync("run guarded")
        yield* Fiber.await(listener)
        return collected
      }),
      layer,
    )

    const done = events.find((e) => e._tag === "ToolDone")
    expect(done).toBeDefined()
    if (done && done._tag === "ToolDone") {
      expect(done.ok).toBe(false)
      expect(done.output).toContain("denied")
    }
  })
})
