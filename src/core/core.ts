/**
 * gloop core — re-exports of the actor-style API from @hypen-space/gloop-loop.
 *
 * Gloop-specific wiring (debug logging, spawn classification, reboot
 * handling) is applied at the call site where the `AgentLoop` is constructed
 * (bin/index.ts, src/core/headless.ts), not here.
 */

export {
  AgentLoop,
  AbortError,
} from "@hypen-space/gloop-loop";

export type {
  AgentLoopOptions,
  AgentMessage,
  AgentMessageRole,
  AgentEvent,
  AgentEventListener,
  SpawnResult,
  // Per-variant named aliases.
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
} from "@hypen-space/gloop-loop";
