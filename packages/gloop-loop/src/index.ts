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
  CoreEvent,
  LoopConfig,
} from "./core/core.js";

export {
  // Form constructors
  Think,
  Continue,
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
  MaxIterationsError,
  LlmIdleTimeoutError,
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
export {
  createFileMemory,
  appendMemory,
  removeMemory,
  readMemory,
} from "./defaults/memory.js";
export type { FileMemory, FileMemoryOptions } from "./defaults/memory.js";
export { manageContextFork } from "./defaults/context-manager.js";
export type { ManageContextOptions } from "./defaults/context-manager.js";

// --- Skills (SKILL.md discovery is host-specific; helpers are portable) ---
export type { Skill, ParsedSkillMarkdown, SkillSlashMatch } from "./skills.js";
export {
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
} from "./skills.js";

// --- Tracing: optional, OTEL-shaped, no deps ---
export type {
  Tracer,
  Span,
  SpanOptions,
  SpanStatus,
  AttributeValue,
  ConsoleTracerOptions,
} from "./trace.js";
export {
  NoopTracer,
  ConsoleTracer,
  withSpan,
  withSpanSync,
} from "./trace.js";

// --- Interceptors: onion-middleware around every boundary ---
export type {
  Interceptor,
  InterceptorFn,
  LlmCallContext,
  LlmCallResult,
  ToolCallContext,
  ToolCallResult,
  ConfirmContext,
  AskContext,
  MemoryContext,
  SpawnContext,
} from "./interceptors.js";
export { chain, chainBoundary } from "./interceptors.js";

// --- Events: the payload union, envelope, and helpers ---
export type {
  AgentMessage,
  AgentMessageRole,
  AgentEvent,
  AgentEventType,
  AgentEventListener,
  EventEnvelope,
  EventRef,
  ErrorInfo,
  LogEvent,
  TurnStatus,
  // Per-variant named aliases for consumer-side type annotations.
  MessageQueuedEvent,
  TurnStartEvent,
  TurnEndEvent,
  BusyEvent,
  IdleEvent,
  QueueChangedEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolMessageEvent,
  HistoryReplacedEvent,
  HistoryClearedEvent,
  SystemSetEvent,
  SystemRefreshedEvent,
  ToolsChangedEvent,
  LlmRequestEvent,
  StreamChunkEvent,
  StreamDoneEvent,
  LlmResponseEvent,
  LlmErrorEvent,
  ToolStartEvent,
  ToolDoneEvent,
  RetryEvent,
  MemoryEvent,
  ConfirmRequestEvent,
  ConfirmResponseEvent,
  AskRequestEvent,
  AskResponseEvent,
  SpawnStartEvent,
  SpawnDoneEvent,
  TaskCompleteEvent,
  InterruptedEvent,
  ErrorEvent,
  FatalEvent,
  HookErrorEvent,
  RestoredEvent,
} from "./events.js";
export { isEphemeralEvent, serializeEvent, toErrorInfo } from "./events.js";

// --- Event log: append-only, subscribable, persistable ---
export type { EventStore, EventLogOptions, AppendOptions, LogSubscriber } from "./log.js";
export { EventLog, MemoryEventStore } from "./log.js";
export type { JsonlEventStore, JsonlEventStoreOptions } from "./defaults/jsonl-store.js";
export { createJsonlEventStore } from "./defaults/jsonl-store.js";

// --- State: rebuild everything from the log ---
export type { AgentState, TurnRecord } from "./state.js";
export { initialState, reduce, projectState, messagesToRequeue } from "./state.js";

// --- Retry ---
export type { RetryPolicy, RetryConfig, RetryAttemptInfo, WithRetryOptions } from "./retry.js";
export { withRetry, backoffDelay, defaultRetryIf } from "./retry.js";

// --- Hooks: attach behaviour / other agents to the log ---
export type { AgentHook, HookTarget, BridgeOptions } from "./hooks.js";
export { bridgeAgents } from "./hooks.js";

// --- AgentLoop: high-level actor-style entry point ---
export { AgentLoop } from "./agent.js";
export type { AgentLoopOptions, HydrateOptions } from "./agent.js";
