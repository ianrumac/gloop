/**
 * @hypen-space/gloop-effect/react
 *
 * "React, for agents." Define an agent as a component — a plain function
 * re-run once per turn. Hooks declare what the agent *is* this turn
 * (`useModel`, `useSystemPrompt`, `useSkill`, `useTool`) and what it
 * *remembers* across turns (`useState`, `usePersistentState`, `useMemory`).
 * `renderAgent` reconciles each render into a live Effect `Agent`.
 */

export {
  renderAgent,
  type AgentApp,
  type AgentComponent,
  type RenderAgentOptions,
} from "./runtime.js"

export {
  // state
  useState,
  usePersistentState,
  useMemo,
  // config (reconciled into the agent each turn)
  useModel,
  useSystemPrompt,
  useMaxTokens,
  useSkill,
  useTool,
  useTools,
  // effects & resources
  useEffect,
  useSandbox,
  // long-term memory + turn context
  useMemory,
  useTurn,
  type SetState,
  type SandboxSpec,
} from "./hooks.js"

export { tool, type ToolBuilder, type Handler, type Handled } from "./tool.js"

export type {
  TurnContext,
  PersistBridge,
  MemoryBridge,
} from "./internal.js"
