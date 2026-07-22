# `@hypen-space/gloop-effect/react` — React, for agents

An experiment: what if an agent were a **component**, each **turn** a
**rerender**, and the thing you **return** described the agent?

```ts
import { Effect } from "effect"
import {
  buildAgent,
  model,
  system,
  skill,
  group,
  tool,
  useState,
} from "@hypen-space/gloop-effect/react"

function SupportAgent() {
  // Hooks are for STATE and EFFECTS.
  const [phase, setPhase] = useState<"triage" | "resolve">("triage")

  // The RETURN VALUE is the config — a node tree, like JSX elements.
  return group(
    model("anthropic/claude-sonnet-4.5"),
    system("You are a support agent."),
    system(phase === "triage" ? "Diagnose first, don't act." : "Fix it."),

    // Conditional config is just `&&` — falsy children drop out.
    phase === "triage"
      ? tool("Classify")
          .arg("kind", "billing | bug | howto")
          .handle((a) => {
            setPhase("resolve") // schedules a rerender — next turn has new tools
            return `noted: ${a.kind}`
          })
      : group(tool("IssueRefund").handle(refund), skill(billingRunbook)),
  )
}

const program = Effect.gen(function* () {
  const app = yield* buildAgent(SupportAgent)
  yield* app.send("I was double charged")
  yield* app.send("yes please refund")
})
```

## What a component returns

A component **returns a node tree** — the agent's config for this turn. That
tree is the analogue of React elements: `buildAgent` flattens it into a config
draft and reconciles the draft into the live `Agent`. Nothing is configured by
side effect; hooks are reserved for state and effects, exactly as in React.

- `model(id)` — the model
- `system(text)` — a prompt section; multiple sections compose in order
- `maxTokens(n)`
- `skill(s)` — auto-registers `InvokeSkill` + merges the catalog into the prompt
- a `tool()` builder — a valid child on its own, no wrapper
- `group(...children)` — the fragment / `<>…</>`; nest freely
- `false` / `null` / `undefined` — dropped, so `cond && node` works

Composition is the payoff: a **reusable fragment is a function that returns
nodes**, spread into a parent.

```ts
const Persona = (name: string) =>
  group(system(`You are ${name}.`), tool("Signoff").handle(() => name))

const BillingTools = () =>
  group(tool("Refund").handle(refund), tool("Charge").handle(charge))

function App() {
  return group(model("…"), Persona("Ada"), BillingTools())
}
```

## The correspondence

| React | Here |
|---|---|
| `render(props) → elements` | `component() → node tree` |
| reconciler commits elements → DOM | runtime flattens the tree → `setSystem` / `setTools` / `setMaxTokens` |
| a component re-runs on every render | the component re-runs **once per turn** |
| `useState` cell hangs off the fiber | `useState` cell hangs off the agent instance |
| `setState` re-renders (commit at next paint) | `setState` re-renders (commit at the next turn boundary) |
| `useEffect(fn, deps)` after commit | same — side effects between turns, with cleanup |
| child components return elements | fragment functions return nodes, composed with `group()` |

"Each turn is a rerender" is literal: before a message reaches the model, the
component runs to compute *what the agent currently is*, and that tree is diffed
into the live agent.

## Hooks (state & effects only)

Backed by a persistent cell — obey the rules of hooks (call unconditionally, top
level):

- `useState(init)` — survives turns, resets on reboot
- `usePersistentState(key, init)` — written through to a store, survives reboot / resume
- `useMemo(factory, deps)`
- `useEffect(setup, deps?)` — runs after commit, returns a cleanup
- `useSandbox({ acquire, release, deps })` — a resource, acquired on mount, released on unmount
- `useMemory()` — the long-term notes bridge (`notes()`, `remember`, `forget`)
- `useTurn()` — `{ message, turn }`

## Stacking LLMs (nested agents / Suspense)

One agent = one LLM. *Stacking* = one component's config computed by another LLM.
A "thinker" observes each message and steers the responder — two models, one
thread:

```ts
function ChatAgent() {
  const turn = useTurn()

  // A nested one-shot LLM. The parent turn SUSPENDS until it resolves.
  const guidance = useThinker({
    model: "cheap-thinker",
    system: "You are the assistant's inner monologue. In one line, say what to " +
            "focus on and the tone. Never address the user.",
    input: turn.message,
  })

  return group(
    model("strong-responder"),
    system("You are a helpful assistant."),
    guidance && system(`Private guidance from your inner voice:\n${guidance}`),
  )
}
```

Per turn the runtime renders, sees the thinker's pending promise, **awaits it and
re-renders**, then runs the responder conditioned on the guidance. The thinker
never talks to the user — it only shapes the responder's *config*, so it can
direct more than the prompt: pick the model (`useModel` on difficulty), gate
tools, set `maxTokens`. A cheap LLM rendering the config for an expensive one.

- `useAsync(fn, deps)` — the Suspense primitive: run a promise as part of render
- `useSubAgent({ model, system, input })` — a nested one-shot LLM, returns its text
- `useThinker(...)` — `useSubAgent` framed as an inner monologue

Runnable: `bun run examples/react-thinker.ts` (scripted stub, no API key).

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

The builder is immutable and structurally *is* a `Tool<ToolExecutionError>`, so
it's a valid child in a component tree **and** drops into `Agent.make({ tools })`.

## Status — prototype

Runnable and tested (`test/react.test.ts`, 5 tests). Known edges:

- **Model is fixed at mount.** A `model()` node that changes after mount logs a
  warning; live model swap needs a `Conversation.setModel` (the model is
  currently closed over in `send`/`stream`, not held in the state `Ref`).
- **Commits land at turn boundaries**, not mid-turn. A tool that calls `setState`
  changes the *next* turn's config, not the current think→invoke loop. Wiring
  re-render into each interpreter iteration is the natural next step.
- Default `persist` / `memory` bridges are in-memory; pass your own (file, kv) via
  `buildAgent(app, { persist, memory })`.
