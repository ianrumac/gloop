/**
 * @hypen-space/gloop-effect/react
 *
 * "React, for agents." An agent is a component — a plain function re-run once
 * per turn. It uses hooks for state and effects (`useState`,
 * `usePersistentState`, `useEffect`, `useMemory`) and *returns a node tree*
 * describing what the agent is this turn (`model`, `system`, `skill`, `tool`,
 * `group`). `buildAgent` flattens each render and reconciles it into a live
 * Effect `Agent`.
 */

export {
  buildAgent,
  type AgentApp,
  type AgentComponent,
  type BuildAgentOptions,
} from "./runtime.js"

// --- Config nodes (the return value of a component) ------------------------
export {
  model,
  system,
  maxTokens,
  skill,
  group,
  flatten,
  type Node,
  type Child,
  type Children,
  type Rendered,
} from "./nodes.js"

// --- Hooks (state & effects only) ------------------------------------------
export {
  useState,
  usePersistentState,
  useMemo,
  useEffect,
  useSandbox,
  useMemory,
  useTurn,
  type SetState,
  type SandboxSpec,
} from "./hooks.js"

// --- The Tool monad (a tool() builder is a valid child on its own) ---------
export { tool, type ToolBuilder, type Handler, type Handled } from "./tool.js"

export type {
  TurnContext,
  PersistBridge,
  MemoryBridge,
} from "./internal.js"
