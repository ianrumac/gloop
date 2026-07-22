/**
 * gloop-effect/react/hooks — the hook surface.
 *
 * Every hook is a synchronous call that either (a) reads/writes a persistent
 * cell, or (b) pushes a declaration into the current render's `Draft`. None of
 * them touch the live agent directly — the runtime reconciles the draft after
 * the render pass, so a component stays a pure description of "what the agent
 * should be, this turn".
 */

import {
  nextCell,
  useInstance,
  type EffectSetup,
  type MemoryBridge,
} from "./internal.js"

const depsChanged = (
  a: ReadonlyArray<unknown> | undefined,
  b: ReadonlyArray<unknown> | undefined,
): boolean => {
  if (a === undefined || b === undefined) return true // no deps => every render
  if (a.length !== b.length) return true
  return a.some((x, i) => !Object.is(x, b[i]))
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

export type SetState<T> = (next: T | ((prev: T) => T)) => void

/**
 * In-memory state that survives across turns but resets on reboot / remount.
 * `setState` schedules a re-render — the change lands on the *next* turn, the
 * same way React commits between paints.
 */
export const useState = <T>(initial: T | (() => T)): [T, SetState<T>] => {
  const inst = useInstance()
  const cell = nextCell(() => ({
    kind: "state" as const,
    value: typeof initial === "function" ? (initial as () => T)() : initial,
  }))
  const set: SetState<T> = (next) => {
    const prev = cell.value as T
    cell.value = typeof next === "function" ? (next as (p: T) => T)(prev) : next
    inst.scheduleRerender()
  }
  return [cell.value as T, set]
}

/**
 * Like `useState`, but the value is written through to a persistent store
 * (memory file / kv), so it survives a `reboot` or session resume. The initial
 * read comes from the mount-time snapshot the runtime loaded.
 */
export const usePersistentState = <T>(
  key: string,
  initial: T,
): [T, SetState<T>] => {
  const inst = useInstance()
  const cell = nextCell(() => {
    const stored = inst.persist.get(key)
    return {
      kind: "persist" as const,
      key,
      value: stored === undefined ? initial : stored,
    }
  })
  const set: SetState<T> = (next) => {
    const prev = cell.value as T
    const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next
    cell.value = value
    inst.persist.set(key, value)
    inst.scheduleRerender()
  }
  return [cell.value as T, set]
}

// ----------------------------------------------------------------------------
// Memo
// ----------------------------------------------------------------------------

export const useMemo = <T>(
  factory: () => T,
  deps: ReadonlyArray<unknown>,
): T => {
  const cell = nextCell(() => ({
    kind: "memo" as const,
    deps: undefined as ReadonlyArray<unknown> | undefined,
    value: undefined as unknown,
  }))
  if (depsChanged(cell.deps, deps)) {
    cell.value = factory()
    cell.deps = deps
  }
  return cell.value as T
}

// ----------------------------------------------------------------------------
// Effects
// ----------------------------------------------------------------------------

/**
 * Run a side effect after the render commits, re-running when `deps` change
 * (omit `deps` to run every turn). The setup may return a cleanup function
 * that runs before the next invocation and on unmount.
 */
export const useEffect = (
  setup: EffectSetup,
  deps?: ReadonlyArray<unknown>,
): void => {
  const inst = useInstance()
  const cell = nextCell(() => ({
    kind: "effect" as const,
    deps: undefined as ReadonlyArray<unknown> | undefined,
    cleanup: undefined as (() => void) | undefined,
  }))
  const i = inst.cursor - 1
  if (depsChanged(cell.deps, deps)) {
    inst.draft.effects.push({ cell: i, deps, setup })
  }
}

// ----------------------------------------------------------------------------
// Async / Suspense — the primitive behind stacked LLMs
// ----------------------------------------------------------------------------

/**
 * Run an async computation as part of the render. On first encounter (or when
 * `deps` change) it starts the promise and registers it with the runtime, which
 * awaits it and re-renders — so by the settled render the resolved value is
 * available synchronously. Returns `undefined` while pending.
 *
 * This is the agent-world analogue of Suspense: the parent render "blocks" on
 * child data before committing the turn.
 */
export const useAsync = <T>(
  run: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): T | undefined => {
  const inst = useInstance()
  const cell = nextCell(() => ({
    kind: "async" as const,
    deps: undefined as ReadonlyArray<unknown> | undefined,
    status: "pending" as "pending" | "done" | "error",
    value: undefined as unknown,
    error: undefined as unknown,
  }))
  if (depsChanged(cell.deps, deps)) {
    cell.deps = deps
    cell.status = "pending"
    const p = run().then(
      (v) => {
        cell.status = "done"
        cell.value = v
      },
      (e) => {
        cell.status = "error"
        cell.error = e
      },
    )
    inst.pending.push(p)
  }
  return cell.status === "done" ? (cell.value as T) : undefined
}

export interface SubAgentSpec {
  /** Which model runs this nested LLM. */
  readonly model: string
  /** Its system prompt — the sub-agent's job description. */
  readonly system: string
  /** The input it observes this turn (e.g. the user's message). */
  readonly input: string
  readonly maxTokens?: number
}

/**
 * Run a nested one-shot LLM and return its text — the building block for
 * *stacking* LLMs. The parent turn waits for this to settle, so the result can
 * flow into the parent's rendered config (system section, model choice, tool
 * gating). Re-runs when `input`/`model`/`system` change.
 */
export const useSubAgent = (spec: SubAgentSpec): string | undefined => {
  const inst = useInstance()
  return useAsync(
    () =>
      inst.llm({
        model: spec.model,
        system: spec.system,
        input: spec.input,
        maxTokens: spec.maxTokens,
      }),
    [spec.model, spec.system, spec.input],
  )
}

/**
 * A "thinker": a sub-agent framed as an inner monologue. Returns its private
 * guidance, which the caller typically injects into the responder's prompt.
 */
export const useThinker = (spec: SubAgentSpec): string | undefined =>
  useSubAgent(spec)

// ----------------------------------------------------------------------------
// Resources
// ----------------------------------------------------------------------------

export interface SandboxSpec<H> {
  /** Acquire the resource. Runs once on mount (or when `deps` change). */
  readonly acquire: () => H
  /** Release it on unmount (or before re-acquiring). */
  readonly release?: (handle: H) => void
  readonly deps?: ReadonlyArray<unknown>
}

/**
 * A scoped resource, acquired on mount and released on unmount — a sandbox, a
 * browser, a DB handle. Built on `useMemo` + `useEffect`, so the handle is
 * available synchronously in the same render (unlike a ref populated in an
 * effect).
 */
export const useSandbox = <H>(spec: SandboxSpec<H>): H => {
  const deps = spec.deps ?? []
  const handle = useMemo(spec.acquire, deps)
  useEffect(() => {
    return () => spec.release?.(handle)
  }, deps)
  return handle
}

// ----------------------------------------------------------------------------
// Long-term memory
// ----------------------------------------------------------------------------

/** The agent's long-term notes: read the snapshot, `remember`, `forget`. */
export const useMemory = (): MemoryBridge => useInstance().memory

/** The current turn's context (message text, turn number). */
export const useTurn = () => useInstance().turn
