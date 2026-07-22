/**
 * gloop-effect/react/internal — the render dispatcher.
 *
 * "React, for agents." A component is a plain function re-run once per turn.
 * During that synchronous pass, hooks read and write a per-instance cell store
 * (rules-of-hooks: cells are indexed by call order) and push declarations into
 * a `Draft`. When the pass finishes, the runtime *reconciles* the draft into
 * the live `Agent` — `setSystem` / `setTools` / `setMaxTokens` — exactly the
 * way React's reconciler commits a VDOM tree into the DOM.
 *
 * There is a single module-level `current` pointer, set for the duration of a
 * synchronous render. Agents are single-threaded per turn, so this mirrors
 * React's dispatcher without needing a fiber field on every hook call.
 */

import type { Skill } from "@hypen-space/gloop-loop"
import type { AnyTool } from "../Tool.js"

// ----------------------------------------------------------------------------
// Turn context — the "props" of a render
// ----------------------------------------------------------------------------

export interface TurnContext {
  /** The user message that opened this turn (empty string on the mount pass). */
  readonly message: string
  /** 0 = mount pass (before any message); 1,2,… = each processed turn. */
  readonly turn: number
}

// ----------------------------------------------------------------------------
// The draft a render pass fills in, then the runtime commits
// ----------------------------------------------------------------------------

export interface PendingEffect {
  readonly cell: number
  readonly deps: ReadonlyArray<unknown> | undefined
  readonly setup: EffectSetup
}

export type EffectSetup = () => void | EffectCleanup
export type EffectCleanup = () => void

/** An ephemeral, per-turn instruction — NOT standing system config. */
export interface Directive {
  readonly text: string
  readonly as: "user" | "assistant"
}

export interface Draft {
  systemParts: string[]
  tools: AnyTool[]
  skills: Skill[]
  model: string | undefined
  maxTokens: number | undefined
  effects: PendingEffect[]
  /** Injected for this turn only, then stripped from history. */
  directives: Directive[]
}

export const emptyDraft = (): Draft => ({
  systemParts: [],
  tools: [],
  skills: [],
  model: undefined,
  maxTokens: undefined,
  effects: [],
  directives: [],
})

// ----------------------------------------------------------------------------
// A hook cell — persistent storage that survives across renders
// ----------------------------------------------------------------------------

export interface StateCell {
  readonly kind: "state"
  value: unknown
}

export interface PersistCell {
  readonly kind: "persist"
  readonly key: string
  value: unknown
}

export interface MemoCell {
  readonly kind: "memo"
  deps: ReadonlyArray<unknown> | undefined
  value: unknown
}

export interface AsyncCell {
  readonly kind: "async"
  deps: ReadonlyArray<unknown> | undefined
  status: "pending" | "done" | "error"
  value: unknown
  error: unknown
}

export interface EffectCell {
  readonly kind: "effect"
  deps: ReadonlyArray<unknown> | undefined
  cleanup: EffectCleanup | undefined
}

export type HookCell =
  | StateCell
  | PersistCell
  | MemoCell
  | EffectCell
  | AsyncCell

// ----------------------------------------------------------------------------
// Bridges — the host capabilities the runtime injects
// ----------------------------------------------------------------------------

/** Synchronous snapshot + async write for `usePersistentState`. */
export interface PersistBridge {
  /** Read a value from the mount-time snapshot. */
  readonly get: (key: string) => unknown
  /** Persist a value (fire-and-forget from the hook's perspective). */
  readonly set: (key: string, value: unknown) => void
}

/** Long-term notes, exposed by `useMemory`. */
export interface MemoryBridge {
  /** Current snapshot of the notes body. */
  readonly notes: () => string
  readonly remember: (content: string) => void
  readonly forget: (content: string) => void
}

/** A one-shot LLM call — the primitive behind stacked/sub-agent hooks. */
export interface LLMRequest {
  readonly model: string
  readonly system?: string
  readonly input: string
  readonly maxTokens?: number
}

export interface LLMBridge {
  (req: LLMRequest): Promise<string>
}

// ----------------------------------------------------------------------------
// The render instance
// ----------------------------------------------------------------------------

export interface RenderInstance {
  cells: HookCell[]
  cursor: number
  draft: Draft
  turn: TurnContext
  /** Marks state dirty so the next turn re-renders (React's setState). */
  scheduleRerender: () => void
  persist: PersistBridge
  memory: MemoryBridge
  /** Run a nested one-shot LLM (stacked agents). Wired by the runtime. */
  llm: LLMBridge
  /**
   * Promises a render pass is waiting on (Suspense). The runtime awaits these
   * and re-renders until the list drains before committing the turn.
   */
  pending: Array<Promise<unknown>>
}

let current: RenderInstance | null = null

export const setCurrent = (instance: RenderInstance | null): void => {
  current = instance
}

export const useInstance = (): RenderInstance => {
  if (current === null) {
    throw new Error(
      "Hook called outside of a render. Hooks may only be called synchronously " +
        "from inside an agent component.",
    )
  }
  return current
}

/** Grab the next cell in call order, creating it on first render. */
export const nextCell = <T extends HookCell>(make: () => T): T => {
  const inst = useInstance()
  const i = inst.cursor++
  if (inst.cells[i] === undefined) inst.cells[i] = make()
  return inst.cells[i] as T
}
