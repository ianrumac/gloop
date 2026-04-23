/**
 * @hypen-space/gloop-effect
 *
 * Effect-TS native agent loop. Pairs with `@hypen-space/gloop-loop` — the
 * Form ADT, slash-command parser, skill helpers, and builtin tool bodies
 * are shared; the actor shell, provider interface, error model, and event
 * bus are rebuilt on Effect primitives (Stream, Fiber, PubSub, Ref).
 */

// --- Agent -----------------------------------------------------------------
export {
  Agent,
  make as makeAgent,
  type AgentMessage,
  type AgentMessageRole,
  type AgentEvent,
  type AgentEventOf,
  type AgentMakeOptions,
} from "./Agent.js"

// --- Errors ----------------------------------------------------------------
export {
  AIProviderError,
  ToolNotFoundError,
  ToolExecutionError,
  ToolPermissionDeniedError,
  AgentInterruptedError,
  FatalAgentError,
  FileIOError,
  ShellExecError,
  MemoryError,
  type AgentError,
} from "./Errors.js"

// --- Provider --------------------------------------------------------------
export {
  AIProvider,
  consumeStream,
  toolCallsOf,
  type StreamResponse,
  type AIProviderImpl,
} from "./AIProvider.js"

// --- Conversation ----------------------------------------------------------
export {
  makeConversation,
  type ConversationHandle,
  type ConversationOptions,
} from "./Conversation.js"

// --- Tools -----------------------------------------------------------------
export {
  makeToolRegistry,
  toJsonTool,
  jsonToolCallsToToolCalls,
  legacyBashConfirm,
  type Tool,
  type ToolArgument,
  type ToolCall,
  type ToolResult,
  type ToolRegistry,
} from "./Tool.js"

// --- Interpreter (for advanced consumers) ---------------------------------
export {
  AgentHooksTag,
  mkWorld,
  evalForm,
  parseInput,
  run,
  formatResults,
  toolCallsToForm,
  type AgentHooks,
  type LoopConfig,
  type World,
} from "./Interpreter.js"

// --- Defaults --------------------------------------------------------------
export { OpenRouterProviderLive } from "./defaults/OpenRouter.js"
export { fileMemory, type FileMemoryHandle } from "./defaults/FileMemory.js"
export {
  primitiveTools,
  toEffectTool,
  createNodeIO,
  type BuiltinIO,
} from "./defaults/Builtins.js"

// --- Schema / branded IDs / event schemas ---------------------------------
export {
  // Branded IDs
  MessageId,
  ToolCallId,
  RequestId,
  ModelId,
  // Message schemas
  Message,
  MessageRole,
  AgentMessage as AgentMessageSchema,
  EnqueuedAgentMessage,
  // Tool data schemas
  ToolArgument as ToolArgumentSchema,
  ToolCall as ToolCallSchema,
  ToolResult as ToolResultSchema,
  // Event schemas (constructable via `{ _tag: "...", ... }`)
  AgentEvent as AgentEventSchema,
  TurnStartEvent,
  TurnEndEvent,
  BusyEvent,
  IdleEvent,
  QueueChangedEvent,
  StreamChunkEvent,
  StreamDoneEvent,
  ToolStartEvent,
  ToolDoneEvent,
  MemoryEvent,
  SystemRefreshedEvent,
  TaskCompleteEvent,
  InterruptedEvent,
  ErrorEvent,
  FatalEvent,
  ConfirmRequestEvent,
  AskRequestEvent,
  // Error / config schemas
  AgentErrorSchema,
  AgentConfig,
  SpawnResult as SpawnResultSchema,
} from "./Schema.js"

// --- Re-exports from gloop-loop (shared surface) --------------------------
export type {
  Skill,
  SpawnResult,
  Form,
  Message as AIMessage,
  AIResponse,
  AIRequestConfig,
  JsonTool,
  JsonToolCall,
  JsonToolFunction,
  JsonToolParameter,
  ToolChoice,
  ProviderRouting,
  AIProviderConfig,
} from "@hypen-space/gloop-loop"

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
  // Skill helpers
  parseSkillMarkdown,
  findSkill,
  mergeSkillsIntoSystem,
  formatSkillsListing,
  applySkillSubstitutions,
  splitSkillArguments,
  matchSkillSlash,
  skillInvocationToThinkInput,
  thinkInputFromSkillSubcommand,
  createInvokeSkillTool,
} from "@hypen-space/gloop-loop"
