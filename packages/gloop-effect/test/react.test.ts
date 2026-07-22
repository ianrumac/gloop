/**
 * react runtime — the "React, for agents" prototype.
 *
 * Shows the four load-bearing claims:
 *   1. a render pass composes system prompt + tools, reconciled into the agent
 *   2. tools change per render as hook state changes (phase machine), and
 *      persistent state is restored from the store on mount (reboot)
 *   3. a tool built with the `tool()` monad executes end-to-end, map included
 *   4. `useEffect` runs on mount and re-runs on dep change, with cleanup
 */

import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import type { AgentEvent } from "../src/index.js"
import {
  renderAgent,
  tool,
  useEffect,
  useModel,
  usePersistentState,
  useSystemPrompt,
  useTool,
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

describe("react — renderAgent", () => {
  it("composes the system prompt and reconciles tools into the live agent", async () => {
    await runTest(
      Effect.gen(function* () {
        const App = () => {
          useModel("stub")
          useSystemPrompt("You are a bot.")
          useSystemPrompt("Be terse.")
          useTool(tool("Ping").describe("ping").handle(() => "pong"))
        }

        const app = yield* renderAgent(App)

        const system = yield* app.agent.conversation.getSystem
        expect(system).toContain("You are a bot.")
        expect(system).toContain("Be terse.")

        expect(yield* app.agent.registry.names).toEqual(["Ping"])
      }),
    )
  })

  it("restores persistent state on mount and swaps tools when it changes", async () => {
    // Store already holds phase="work" — as if restored after a reboot.
    const [store, persist] = storeBridge({ phase: "work" })

    await runTest(
      Effect.gen(function* () {
        let setPhase: SetState<string> = () => {}
        const App = () => {
          useModel("stub")
          const [phase, sp] = usePersistentState("phase", "intake")
          setPhase = sp
          if (phase === "intake") useTool(tool("Collect").handle(() => "c"))
          else useTool(tool("Deploy").handle(() => "d"))
        }

        const app = yield* renderAgent(App, { persist })

        // Mounted from the store, not the default.
        expect(yield* app.agent.registry.names).toEqual(["Deploy"])

        // setState persists through the bridge and drives the next render.
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
        const App = () => {
          useModel("stub")
          useSystemPrompt("t")
          useTool(
            tool("Ping")
              .describe("ping")
              .handle(() => "pong")
              .map((o) => o.toUpperCase())
              .tap((o) => Effect.sync(() => void (captured = o))),
          )
        }
        const app = yield* renderAgent(App)

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
    expect(done).toBeDefined()
    if (done && done._tag === "ToolDone") {
      expect(done.name).toBe("Ping")
      expect(done.ok).toBe(true)
    }
    // The map ran: the model received the transformed output.
    expect(captured).toBe("PONG")
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
        }

        const app = yield* renderAgent(App, { persist })
        expect(log).toEqual(["setup:0"])

        setN(1)
        yield* app.rerender
        expect(log).toEqual(["setup:0", "cleanup:0", "setup:1"])

        // Same deps => effect does not re-run.
        yield* app.rerender
        expect(log).toEqual(["setup:0", "cleanup:0", "setup:1"])
      }),
    )
  })
})
