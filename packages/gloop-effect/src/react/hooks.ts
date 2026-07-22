/**
 * gloop-effect/react/hooks — the hook surface.
 *
 * Every hook is a synchronous call that either (a) reads/writes a persistent
 * cell, or (b) pushes a declaration into the current render's `Draft`. None of
 * them touch the live agent directly — the runtime reconciles the draft after
 * the render pass, so a component stays a pure description of "what the agent
 * should be, this turn".
 */

import { Option } from "effect"
import type { Skill } from "@hypen-space/gloop-loop"
import type { AnyTool } from "../Tool.js"
import {
  nextCell,
  useInstance,
  type EffectSetup,
  type MemoryBridge,
} from "./internal.js"
import type { ToolBuilder } from "./tool.js"

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
// Configuration hooks — these push into the draft
// ----------------------------------------------------------------------------

/** Declare the model for this turn. (Prototype: honored at mount.) */
export const useModel = (model: string): void => {
  useInstance().draft.model = model
}

/**
 * Contribute a section to the system prompt. Multiple calls compose in order —
 * prompt sections behave like rendered children, not one monolithic string.
 */
export const useSystemPrompt = (text: string): void => {
  useInstance().draft.systemParts.push(text)
}

/** Cap output tokens for this turn. */
export const useMaxTokens = (n: number): void => {
  useInstance().draft.maxTokens = n
}

/** Make a skill available this turn. Conditionally include based on state. */
export const useSkill = (skill: Skill): void => {
  useInstance().draft.skills.push(skill)
}

/** Register a single tool for this turn. */
export const useTool = (t: ToolBuilder | AnyTool): void => {
  useInstance().draft.tools.push(t as AnyTool)
}

/** Register several tools for this turn. */
export const useTools = (
  tools: ReadonlyArray<ToolBuilder | AnyTool>,
): void => {
  const draft = useInstance().draft
  for (const t of tools) draft.tools.push(t as AnyTool)
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
