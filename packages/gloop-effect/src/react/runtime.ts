/**
 * gloop-effect/react/runtime — `buildAgent`: mount a component, reconcile it
 * into a live `Agent`, re-render once per turn.
 *
 * The loop:
 *   1. mount   — render pass #0 (turn 0, no message) computes initial config;
 *                `Agent.make` is built from it, then effects/resources commit.
 *   2. send    — render pass #N re-runs the component, the runtime diffs the
 *                fresh draft into the agent (`setSystem` / `setTools` /
 *                `setMaxTokens`), runs changed effects, then `sendSync`.
 *
 * "Each turn is a rerender" is literal: the component is what decides, per
 * turn, which tools/skills/prompt the agent is holding — so phase machines,
 * mode switches, and progressive disclosure fall out of ordinary `if`s over
 * hook state.
 */

import { Effect, Runtime, Scope } from "effect"
import {
  createInvokeSkillTool,
  mergeSkillsIntoSystem,
} from "@hypen-space/gloop-loop"
import { Agent, type AgentMakeOptions } from "../Agent.js"
import type { AgentError } from "../Errors.js"
import { AIProvider } from "../AIProvider.js"
import { toEffectTool } from "../defaults/Builtins.js"
import type { AnyTool } from "../Tool.js"
import {
  emptyDraft,
  setCurrent,
  type Draft,
  type EffectCell,
  type MemoryBridge,
  type PersistBridge,
  type RenderInstance,
} from "./internal.js"
import { flatten, type Rendered } from "./nodes.js"

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5"

/**
 * A component: a plain function re-run each turn. It uses hooks for state and
 * effects, and *returns* a node tree describing the agent's config this turn.
 */
export type AgentComponent = () => Rendered

export interface BuildAgentOptions {
  /** Backing store for `usePersistentState`. Defaults to in-memory. */
  readonly persist?: PersistBridge
  /** Backing store for `useMemory`. Defaults to in-memory. */
  readonly memory?: MemoryBridge
  /** Passed through to `Agent.make`. */
  readonly confirm?: AgentMakeOptions["confirm"]
  readonly ask?: AgentMakeOptions["ask"]
  readonly log?: AgentMakeOptions["log"]
  readonly maxIterations?: AgentMakeOptions["maxIterations"]
}

export interface AgentApp {
  readonly agent: Agent
  /** Render → reconcile → run the turn. This is one "rerender". */
  readonly send: (message: string) => Effect.Effect<void, AgentError>
  /** Force a render + reconcile without sending a message. */
  readonly rerender: Effect.Effect<void>
}

// ----------------------------------------------------------------------------
// Default bridges
// ----------------------------------------------------------------------------

const inMemoryPersist = (): PersistBridge => {
  const store = new Map<string, unknown>()
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value)
    },
  }
}

const inMemoryMemory = (): MemoryBridge => {
  const notes: string[] = []
  return {
    notes: () => notes.join("\n"),
    remember: (content) => {
      if (!notes.includes(content)) notes.push(content)
    },
    forget: (content) => {
      const i = notes.indexOf(content)
      if (i >= 0) notes.splice(i, 1)
    },
  }
}

// ----------------------------------------------------------------------------
// buildAgent
// ----------------------------------------------------------------------------

export const buildAgent = (
  component: AgentComponent,
  options: BuildAgentOptions = {},
): Effect.Effect<AgentApp, never, AIProvider | Scope.Scope> =>
  Effect.gen(function* () {
    let dirty = false

    // Capture provider + runtime so hooks can run nested one-shot LLMs
    // (stacked agents) as plain Promises during a render.
    const provider = yield* AIProvider
    const rt = yield* Effect.runtime<AIProvider>()
    const llm = (req: {
      model: string
      system?: string
      input: string
      maxTokens?: number
    }): Promise<string> =>
      Runtime.runPromise(rt)(
        provider
          .complete({
            model: req.model,
            messages: [
              ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
              { role: "user" as const, content: req.input },
            ],
            maxTokens: req.maxTokens ?? 1024,
          })
          .pipe(Effect.map((r) => r.content ?? "")),
      )

    const instance: RenderInstance = {
      cells: [],
      cursor: 0,
      draft: emptyDraft(),
      turn: { message: "", turn: 0 },
      scheduleRerender: () => {
        dirty = true
      },
      persist: options.persist ?? inMemoryPersist(),
      memory: options.memory ?? inMemoryMemory(),
      llm,
      pending: [],
    }

    // --- A single synchronous render pass -------------------------------
    const render = (message: string, turn: number): Draft => {
      instance.cursor = 0
      instance.draft = emptyDraft()
      instance.pending = []
      instance.turn = { message, turn }
      setCurrent(instance)
      let output: Rendered
      try {
        output = component()
      } finally {
        setCurrent(null)
      }
      // Hooks filled draft.effects; the returned tree fills the config.
      flatten(output, instance.draft)
      dirty = false
      return instance.draft
    }

    // Render, then await any Suspense promises (nested LLMs) and re-render
    // until the tree settles — so stacked sub-agents resolve before commit.
    const renderSettled = (
      message: string,
      turn: number,
    ): Effect.Effect<Draft> =>
      Effect.gen(function* () {
        let draft = render(message, turn)
        let guard = 0
        while (instance.pending.length > 0 && guard++ < 16) {
          const ps = instance.pending
          yield* Effect.promise(() => Promise.all(ps))
          draft = render(message, turn)
        }
        return draft
      })

    // --- Turn the draft into the tool list the model actually sees ------
    const resolveTools = (draft: Draft): ReadonlyArray<AnyTool> => {
      const tools = [...draft.tools]
      const hasInvokeSkill = tools.some((t) => t.name === "InvokeSkill")
      if (draft.skills.length > 0 && !hasInvokeSkill) {
        const invoke = createInvokeSkillTool([...draft.skills])
        if (invoke) tools.unshift(toEffectTool(invoke))
      }
      return tools
    }

    const resolveSystem = (draft: Draft): string =>
      mergeSkillsIntoSystem(
        draft.systemParts.length > 0 ? draft.systemParts.join("\n\n") : undefined,
        [...draft.skills],
      )

    // --- Run the effects a render scheduled (with cleanup) -------------
    const runEffects = (draft: Draft): Effect.Effect<void> =>
      Effect.sync(() => {
        for (const e of draft.effects) {
          const cell = instance.cells[e.cell] as EffectCell
          if (cell.cleanup) cell.cleanup()
          const cleanup = e.setup()
          cell.cleanup = typeof cleanup === "function" ? cleanup : undefined
          cell.deps = e.deps
        }
      })

    // --- Mount: render #0, build the agent from it ---------------------
    const mount = yield* renderSettled("", 0)
    const model = mount.model ?? DEFAULT_MODEL

    const agent = yield* Agent.make({
      model,
      system: resolveSystem(mount),
      tools: resolveTools(mount),
      ...(mount.maxTokens !== undefined ? { maxTokens: mount.maxTokens } : {}),
      confirm: options.confirm,
      ask: options.ask,
      log: options.log,
      maxIterations: options.maxIterations,
    })

    yield* runEffects(mount)

    // Tear down every live effect when the scope closes (unmount).
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const cell of instance.cells) {
          if (cell?.kind === "effect" && cell.cleanup) cell.cleanup()
        }
      }),
    )

    // --- Reconcile a fresh draft into the live agent -------------------
    const commit = (draft: Draft): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* agent.conversation.setSystem(resolveSystem(draft))
        yield* agent.setTools(resolveTools(draft))
        if (draft.maxTokens !== undefined) {
          yield* agent.conversation.setMaxTokens(draft.maxTokens)
        }
        if (draft.model !== undefined && draft.model !== model) {
          yield* Effect.logWarning(
            `model(): model is fixed at mount in this prototype ` +
              `(requested "${draft.model}", running "${model}")`,
          )
        }
        yield* runEffects(draft)
      })

    let turnNo = 0

    const send: AgentApp["send"] = (message) =>
      Effect.gen(function* () {
        turnNo += 1
        const draft = yield* renderSettled(message, turnNo)
        yield* commit(draft)
        yield* agent.sendSync(message)
      })

    const rerender: AgentApp["rerender"] = Effect.gen(function* () {
      const draft = yield* renderSettled(instance.turn.message, turnNo)
      yield* commit(draft)
    })

    // `dirty` is read by callers who want to know a rerender is pending;
    // `send` always re-renders, so it stays advisory.
    void dirty

    return { agent, send, rerender } satisfies AgentApp
  })
