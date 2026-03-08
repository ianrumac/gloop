// ============================================================================
// @anthropic/gloop-loop — A recursive Lisp-style agent loop for LLM agents
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
} from "./ai/types.ts";

export { AI, AIBuilder, AIConversation } from "./ai/builder.ts";
export { OpenRouterProvider } from "./ai/provider.ts";

// --- Tool layer: registry, types, parsing, validation ---
export type {
  ToolArgument,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from "./tools/types.ts";

export { ToolRegistry } from "./tools/registry.ts";
export { jsonToolCallsToToolCalls } from "./tools/parser.ts";
export { requiresConfirmation } from "./tools/validator.ts";

// --- Builtin tools: portable tool implementations ---
export type { BuiltinIO, ShellResult } from "./tools/builtins.ts";
export { registerBuiltins, formatShellResult } from "./tools/builtins.ts";

// --- Core loop: forms, interpreter, runner ---
export type {
  Form,
  SpawnResult,
  Continuation,
  World,
  Effects,
  LoopConfig,
} from "./core/core.ts";

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
  mkWorld,
  // Interpreter
  eval_,
  toolCallsToForm,
  formatResults,
  parseInput,
  run,
} from "./core/core.ts";
