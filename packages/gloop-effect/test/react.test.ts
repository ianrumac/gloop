/**
 * react runtime — the "React, for agents" prototype (return-a-tree model).
 *
 * A component uses hooks for state/effects and *returns* a node tree for
 * config. Shows:
 *   1. a returned tree composes system prompt + tools, reconciled into the agent
 *   2. reusable fragment components compose via group()
 *   3. tools change per render as hook state changes (phase machine)
 *   4. a tool built with the tool() monad executes end-to-end, map included
 *   5. useEffect runs on mount and re-runs on dep change, with cleanup
 */

import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { AIProvider, type AgentEvent, type AIProviderImpl } from "../src/index.js"
import {
  buildAgent,
  group,
  model,
  system,
  tool,
  useEffect,
  usePersistentState,
  useThinker,
  useTurn,
  type PersistBridge,
  type SetState,
} from "../src/react/index.js"
import { runTest, StubProviderLayer } from "./helpers.js"

const storeBridge = (
  init: Record<string, unknown>,
): [Map<string, unknown>, PersistBridge] => {
  const store = new Map<string, unknown>(Object.entries(init))
  return [store, { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) }]
}

describe("react — buildAgent (return-a-tree)", () => {
  it("flattens a returned tree into system prompt + tools", async () => {
    await runTest(
      Effect.gen(function* () {
        const App = () =>
          group(
            model("stub"),
            system("You are a bot."),
            system("Be terse."),
            tool("Ping").describe("ping").handle(() => "pong"),
          )

        const app = yield* buildAgent(App)

        const sys = yield* app.agent.conversation.getSystem
        expect(sys).toContain("You are a bot.")
        expect(sys).toContain("Be terse.")
        expect(yield* app.agent.registry.names).toEqual(["Ping"])
      }),
    )
  })

  it("composes reusable fragment components", async () => {
    // A fragment is just a function returning nodes.
    const Persona = (name: string) =>
      group(system(`You are ${name}.`), tool("Signoff").handle(() => name))
    const BillingTools = () =>
      group(tool("Refund").handle(() => "refunded"), tool("Charge").handle(() => "charged"))

    await runTest(
      Effect.gen(function* () {
        const App = () => group(model("stub"), Persona("Ada"), BillingTools())
        const app = yield* buildAgent(App)

        const sys = yield* app.agent.conversation.getSystem
        expect(sys).toContain("You are Ada.")
        expect(yield* app.agent.registry.names).toEqual(["Signoff", "Refund", "Charge"])
      }),
    )
  })

  it("swaps tools per render as state changes (conditional children)", async () => {
    const [store, persist] = storeBridge({ phase: "work" })

    await runTest(
      Effect.gen(function* () {
        let setPhase: SetState<string> = () => {}
        const App = () => {
          const [phase, sp] = usePersistentState("phase", "intake")
          setPhase = sp
          return group(
            model("stub"),
            phase === "intake"
              ? tool("Collect").handle(() => "c")
              : tool("Deploy").handle(() => "d"),
          )
        }

        const app = yield* buildAgent(App, { persist })
        expect(yield* app.agent.registry.names).toEqual(["Deploy"])

        setPhase("intake")
        expect(store.get("phase")).toBe("intake")
        yield* app.rerender
        expect(yield* app.agent.registry.names).toEqual(["Collect"])
      }),
    )
  })

  it("executes a tool built with the tool() monad, map included", async () => {
    const layer = StubProviderLayer([
      {
        chunks: [""],
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "Ping", arguments: JSON.stringify({}) },
          },
        ],
      },
      { chunks: ["done"] },
    ])

    let captured = ""

    const events = await runTest(
      Effect.gen(function* () {
        const App = () =>
          group(
            model("stub"),
            system("t"),
            tool("Ping")
              .describe("ping")
              .handle(() => "pong")
              .map((o) => o.toUpperCase())
              .tap((o) => Effect.sync(() => void (captured = o))),
          )
        const app = yield* buildAgent(App)

        const collected: AgentEvent[] = []
        const listener = yield* Effect.fork(
          app.agent.events.pipe(
            Stream.takeUntil((e) => e._tag === "TurnEnd"),
            Stream.runForEach((e) => Effect.sync(() => void collected.push(e))),
          ),
        )
        yield* app.send("go")
        yield* Fiber.await(listener)
        return collected
      }),
      layer,
    )

    const done = events.find((e) => e._tag === "ToolDone")
    expect(done?._tag === "ToolDone" && done.name).toBe("Ping")
    expect(done?._tag === "ToolDone" && done.ok).toBe(true)
    expect(captured).toBe("PONG")
  })

  it("stacks a thinker LLM into the responder's prompt (Suspense)", async () => {
    // complete() serves the thinker; stream() serves the responder.
    const provider: AIProviderImpl = {
      name: "stub",
      complete: (req) =>
        Effect.succeed({
          id: "t",
          model: req.model,
          content: "FOCUS::BILLING",
          finishReason: "stop",
        }),
      stream: (req) => ({
        chunks: Stream.empty,
        result: Effect.succeed({ id: "r", model: req.model, content: "", finishReason: "stop" }),
        cancel: Effect.void,
      }),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const App = () => {
            const turn = useTurn()
            const guidance = useThinker({
              model: "thinker",
              system: "inner voice",
              input: turn.message || "start",
            })
            return group(
              model("responder"),
              system("You are helpful."),
              guidance ? system(`guidance: ${guidance}`) : false,
            )
          }

          // Mount suspends on the thinker; by the time buildAgent returns, the
          // guidance is already merged into the system prompt.
          const app = yield* buildAgent(App)
          const sys = yield* app.agent.conversation.getSystem
          expect(sys).toContain("FOCUS::BILLING")
        }),
      ).pipe(Effect.provide(Layer.succeed(AIProvider, provider))),
    )
  })

  it("runs useEffect on mount and re-runs on dep change with cleanup", async () => {
    const [, persist] = storeBridge({ n: 0 })
    const log: string[] = []

    await runTest(
      Effect.gen(function* () {
        let setN: SetState<number> = () => {}
        const App = () => {
          const [n, sn] = usePersistentState("n", 0)
          setN = sn
          useEffect(() => {
            log.push(`setup:${n}`)
            return () => log.push(`cleanup:${n}`)
          }, [n])
          return model("stub")
        }

        const app = yield* buildAgent(App, { persist })
        expect(log).toEqual(["setup:0"])

        setN(1)
        yield* app.rerender
        expect(log).toEqual(["setup:0", "cleanup:0", "setup:1"])

        yield* app.rerender
        expect(log).toEqual(["setup:0", "cleanup:0", "setup:1"])
      }),
    )
  })
})
