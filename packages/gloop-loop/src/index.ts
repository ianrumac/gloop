// ============================================================================
// @hypen-space/gloop-loop — A recursive Lisp-style agent loop for LLM agents
// ============================================================================

// --- AI layer: provider interface, conversation, builder ---
export type {
  MessageRole,
  Message,
  ProviderRouting,
  JsonToolParameter,
  JsonToolFunction,
  JsonTool,
  ToolChoice,
  JsonToolCall,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  AIProvider,
  AIProviderConfig,
  Lazy,
} from "./ai/types.js";

export { AI, AIBuilder, AIConversation } from "./ai/builder.js";
export { OpenRouterProvider } from "./ai/provider.js";

// --- Tool layer: registry, types, parsing, validation ---
export type {
  ToolArgument,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from "./tools/types.js";

export { ToolRegistry } from "./tools/registry.js";
export { jsonToolCallsToToolCalls } from "./tools/parser.js";
export { requiresConfirmation } from "./tools/validator.js";

// --- Builtin tools: portable tool implementations ---
export type { BuiltinIO, ShellResult } from "./tools/builtins.js";
export { primitiveTools, registerBuiltins, formatShellResult } from "./tools/builtins.js";

// --- Core loop: forms, interpreter, runner ---
export type {
  Form,
  SpawnResult,
  Continuation,
  World,
  Effects,
  LoopConfig,
} from "./core/core.js";

export {
  // Form constructors
  Think,
  Invoke,
  Confirm,
  Ask,
  Remember,
  Forget,
  Emit,
  Refresh,
  Done,
  Seq,
  Nil,
  Install,
  ListTools,
  Spawn,
  // World
  AbortError,
  raceAbort,
  mkWorld,
  // Interpreter
  eval_,
  toolCallsToForm,
  formatResults,
  parseInput,
  run,
} from "./core/core.js";

// --- Defaults: batteries-included implementations ---
export { createNodeIO } from "./defaults/io.js";
export { appendMemory, removeMemory, readMemory } from "./defaults/memory.js";
export { manageContextFork } from "./defaults/context-manager.js";
export { createEffects } from "./defaults/effects.js";
export type { DefaultEffectsOptions } from "./defaults/effects.js";

// --- AgentLoop: high-level entry point ---
export { AgentLoop } from "./agent.js";
export type { AgentLoopOptions } from "./agent.js";
