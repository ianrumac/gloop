# `@hypen-space/gloop-effect/react` — React, for agents

An experiment: what if an agent were a **component**, and each **turn** were a
**rerender**?

```ts
import { Effect } from "effect"
import {
  renderAgent,
  useModel,
  useSystemPrompt,
  useState,
  useSkill,
  useTool,
  tool,
} from "@hypen-space/gloop-effect/react"

function SupportAgent() {
  useModel("anthropic/claude-sonnet-4.5")

  const [phase, setPhase] = useState<"triage" | "resolve">("triage")

  // Prompt sections compose like children, not one monolith.
  useSystemPrompt("You are a support agent.")
  useSystemPrompt(
    phase === "triage"
      ? "Figure out what the user needs. Don't act yet."
      : "You know the problem. Fix it.",
  )

  // Tools are conditional on state — progressive disclosure falls out of `if`.
  if (phase === "triage") {
    useTool(
      tool("Classify")
        .describe("Record what the user is asking for")
        .arg("kind", "billing | bug | howto")
        .handle((a) => {
          setPhase("resolve") // schedules a rerender — next turn has new tools
          return `noted: ${a.kind}`
        }),
    )
  } else {
    useTool(tool("IssueRefund").describe("…").handle(refund))
    useSkill(billingRunbook)
  }
}

const program = Effect.gen(function* () {
  const app = yield* renderAgent(SupportAgent)
  yield* app.send("I was double charged")
  yield* app.send("yes please refund")
})
```

## The correspondence

| React | Here |
|---|---|
| `render(props) → VDOM` | `component() → AgentConfig` (system, model, tools, skills) |
| reconciler commits VDOM → DOM | runtime reconciles config → live `Agent` (`setSystem` / `setTools` / `setMaxTokens`) |
| a component re-runs on every render | the component re-runs **once per turn** |
| `useState` — cell hangs off the fiber | `useState` — cell hangs off the agent instance |
| `setState` re-renders (commit at next paint) | `setState` re-renders (commit at the next turn boundary) |
| `useEffect(fn, deps)` after commit | same — side effects between turns, with cleanup |
| conditionally render children | conditionally `useTool` / `useSkill` (they don't consume cells) |

"Each turn is a rerender" is literal: before a message reaches the model, the
component runs to compute *what the agent currently is*, and that draft is diffed
into the live agent. Phase machines, mode switches, and tool gating become
ordinary `if`s over hook state instead of imperative `addTool`/`removeTool`
choreography.

## Hooks

**Configuration** (pushed into the render draft, reconciled after the pass — safe
to call conditionally):

- `useModel(id)` — the model for this turn
- `useSystemPrompt(text)` — one section; multiple calls compose in order
- `useMaxTokens(n)`
- `useSkill(skill)` — auto-registers `InvokeSkill` + merges the catalog into the prompt
- `useTool(t)` / `useTools(ts)` — accepts a `tool()` builder or a plain `Tool`

**State** (backed by a persistent cell — obey the rules of hooks, call
unconditionally, top level):

- `useState(init)` — survives turns, resets on reboot
- `usePersistentState(key, init)` — written through to a store, survives reboot / resume
- `useMemo(factory, deps)`
- `useEffect(setup, deps?)` — runs after commit, returns a cleanup
- `useSandbox({ acquire, release, deps })` — a resource, acquired on mount, released on unmount
- `useMemory()` — the long-term notes bridge (`notes()`, `remember`, `forget`)
- `useTurn()` — `{ message, turn }`

## The Tool monad

A tool is a Kleisli arrow `args → Effect<output>`. `tool(name)` builds one
fluently and gives you the operations on that arrow:

```ts
tool("Search")
  .describe("Search the web")
  .arg("query", "the query")
  .handle((a) => fetch(`/s?q=${a.query}`).then((r) => r.text())) // Effect | Promise | string
  .map((raw) => summarize(raw))          // functor: transform output
  .flatMap((s) => rankEffect(s))         // monad bind: chain an effectful step
  .tap((out) => Effect.log(out))         // side effect, output unchanged
  .confirmWhen((a) => a.query.includes("delete")) // gate behind a confirm prompt
```

The builder is immutable and structurally *is* a `Tool<ToolExecutionError>`, so it
drops straight into `useTool` or `Agent.make({ tools })`.

## Status — prototype

Runnable and tested (`test/react.test.ts`). Known edges:

- **Model is fixed at mount.** `useModel` after mount logs a warning; live model
  swap needs a `Conversation.setModel` (the model is currently closed over in
  `send`/`stream`, not held in the state `Ref`). Small follow-up.
- **Commits land at turn boundaries**, not mid-turn. A tool that calls `setState`
  changes the *next* turn's config, not the current think→invoke loop. Wiring
  re-render into each interpreter iteration is the natural next step.
- Default `persist` / `memory` bridges are in-memory; pass your own (file, kv) via
  `renderAgent(app, { persist, memory })`.
