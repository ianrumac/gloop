/**
 * gloop-loop/events — The event model.
 *
 * Everything the agent does is an event: a message entering the inbox, a
 * turn starting, the LLM being called, a chunk streaming back, a tool
 * running, memory being written, the system prompt changing, a hook
 * failing.  Events are appended to an `EventLog` (see `log.ts`) and every
 * piece of agent state can be rebuilt from that log with `projectState`
 * (see `state.ts`).
 *
 * Two layers:
 *
 *   - `AgentEvent`  — the payload union, discriminated on `type`.  This is
 *                     what the interpreter and actor *produce*.
 *   - `LogEvent`    — `AgentEvent & EventEnvelope`.  The envelope is added
 *                     by the log on append: sequence number, id, timestamp,
 *                     run id, agent id, turn id, and the causal `parent`
 *                     edge that turns the log into a graph.
 *
 * Subscribers (`agent.on`, `agent.onEvent`, `agent.attach`, `log.subscribe`)
 * always receive `LogEvent`s.
 */

import type { FinishReason, JsonToolCall, Message } from "./ai/types.js";

// ============================================================================
// Messages sent INTO the actor
// ============================================================================

export type AgentMessageRole = "user" | "system";

/** Reference to an event — used to link events across agents / logs. */
export interface EventRef {
  /** Id of the agent whose log holds the event. */
  agent: string;
  /** The event's `eventId`. */
  eventId: string;
  /**
   * Locator of the log that holds the event when it is NOT the same log
   * (a spawned subprocess pointing back at its parent's session file).
   * Host-defined string — for the JSONL store it is the file path.
   */
  log?: string;
}

export interface AgentMessage {
  /**
   * Optional correlation id.  `send` auto-generates one if missing so that
   * `turn_start` events can be matched back to the originating message.
   * `sendSync` uses this to know which `turn_end` is "theirs".
   */
  id?: string;
  /**
   * Message role.
   *
   * - `"user"` (default): passed to the LLM as a user turn.  The actor
   *   runs a normal think → invoke cycle.
   * - `"system"`: updates the conversation's system prompt immediately
   *   when the loop picks it up, then finishes the turn without calling
   *   the LLM.  Useful for ordering prompt changes against queued user
   *   messages.
   */
  role: AgentMessageRole;
  content: string;
  /**
   * The event (possibly in another agent's log) that caused this message.
   * Set by `bridgeAgents` so cross-agent causality is recorded in the graph.
   */
  cause?: EventRef;
}

// ============================================================================
// Event payloads
// ============================================================================

/** Why a turn ended. */
export type TurnStatus = "ok" | "error" | "interrupted" | "fatal";

/** Serialisable view of an error (what a persisted `error` event carries). */
export interface ErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

export type AgentEvent =
  // ---- Inbox / turn lifecycle ---------------------------------------------
  /** A message was enqueued (`send` / `sendSync` / requeue on resume). */
  | { type: "message_queued"; message: AgentMessage }
  /** A turn has been taken off the inbox and is about to be processed. */
  | { type: "turn_start"; message: AgentMessage }
  /** The current turn finished.  `status` says how. */
  | { type: "turn_end"; status: TurnStatus }
  /** The loop picked up work — a turn is in flight. */
  | { type: "busy" }
  /** The loop finished all inbox work and is waiting. */
  | { type: "idle" }
  /** Inbox size changed (enqueue / dequeue). */
  | { type: "queue_changed"; pending: number }

  // ---- Conversation history (the reducer rebuilds `history` from these) ---
  /** A user message was appended to the conversation history. */
  | { type: "user_message"; content: string }
  /**
   * An assistant message was appended to the history.  `partial` marks text
   * captured from an interrupted stream.
   */
  | { type: "assistant_message"; content: string; toolCalls?: JsonToolCall[]; partial?: boolean }
  /**
   * Tool calls were attached to the most recent assistant message.  The
   * interpreter records the streamed text first and attaches the calls once
   * the tools have run, so an abort in between never leaves unanswered
   * tool calls in history.
   */
  | { type: "assistant_tool_calls"; toolCalls: JsonToolCall[] }
  /** A native `role: "tool"` response was appended to history. */
  | { type: "tool_message"; toolCallId: string; content: string }
  /** The whole history was replaced (context pruning, host restore, ...). */
  | { type: "history_replaced"; history: Message[]; reason: string }
  /** `agent.clear()` — history emptied. */
  | { type: "history_cleared" }
  /** The system prompt changed (`setSystem`, a system message, `refreshSystem`). */
  | { type: "system_set"; system: string }
  /** System prompt was refreshed (e.g. after Reload). */
  | { type: "system_refreshed" }
  /** The registered tool set changed (`addTool` / `removeTool` / `setTools`). */
  | { type: "tools_changed"; names: string[] }

  // ---- LLM boundary --------------------------------------------------------
  /** About to call the model. */
  | { type: "llm_request"; model: string; input: string | null; historyLength: number; toolCount: number }
  /** A streamed chunk of assistant text. */
  | { type: "stream_chunk"; text: string }
  /** The streaming assistant message finished (may be followed by tool calls). */
  | { type: "stream_done" }
  /** The model responded (full text, tool calls, finish reason). */
  | { type: "llm_response"; text: string; toolCalls: JsonToolCall[]; finishReason: FinishReason }
  /** The model call failed (before any retry decision). */
  | { type: "llm_error"; error: ErrorInfo; attempt: number }

  // ---- Tool boundary -------------------------------------------------------
  /** A tool invocation started.  `id` is stable through tool_done. */
  | { type: "tool_start"; id: string; name: string; preview: string; args?: Record<string, string>; callId?: string }
  /** A tool invocation finished.  `id` matches the prior tool_start. */
  | { type: "tool_done"; id: string; name: string; ok: boolean; output: string }
  /** A boundary failed and will be retried after `delayMs`. */
  | { type: "retry"; boundary: "llm" | "tool"; name?: string; attempt: number; maxAttempts: number; delayMs: number; error: ErrorInfo }

  // ---- Memory --------------------------------------------------------------
  /** The agent wrote a memory entry. */
  | { type: "memory"; op: "remember" | "forget"; content: string }

  // ---- Human-in-the-loop ---------------------------------------------------
  /** The actor wants a yes/no confirmation.  Answer with `respondToConfirm`. */
  | { type: "confirm_request"; id: string; command: string }
  /** A confirmation was answered (by the host, a callback, or an interrupt). */
  | { type: "confirm_response"; id: string; ok: boolean }
  /** The actor wants a free-form answer.  Answer with `respondToAsk`. */
  | { type: "ask_request"; id: string; question: string }
  /** A question was answered. */
  | { type: "ask_response"; id: string; answer: string }

  // ---- Sub-agents ----------------------------------------------------------
  /** A subagent was spawned for `task`. */
  | { type: "spawn_start"; task: string }
  /**
   * The subagent finished.  `child` identifies the child's own agent id and
   * event log when the spawn handler reports them, so the child's events
   * can be loaded and joined to this log (`linkedLogs`, `projectGraph`).
   */
  | { type: "spawn_done"; ok: boolean; exitCode: number; summary: string; child?: { agent: string; log?: string } }

  // ---- Outcomes ------------------------------------------------------------
  /** The agent called CompleteTask / Done. */
  | { type: "task_complete"; summary: string }
  /** The current turn was interrupted by `interrupt()`. */
  | { type: "interrupted" }
  /**
   * The current turn failed with a non-abort, non-fatal error.  `error` is
   * always an `Error` instance in-process; after a round-trip through a
   * store it is a plain `ErrorInfo` object.
   */
  | { type: "error"; error: Error | ErrorInfo }
  /**
   * The current turn failed with an error the host classified as **fatal**
   * via `AgentLoopOptions.isFatal`.  The actor has already stopped.
   */
  | { type: "fatal"; error: Error | ErrorInfo }

  // ---- Meta ----------------------------------------------------------------
  /** A hook attached with `agent.attach` threw or rejected. */
  | { type: "hook_error"; hook: string; eventType: string; error: ErrorInfo }
  /**
   * The actor rebuilt its state from the log (`hydrate` / `resume`).
   * Carries the history/system the actor now holds — a turn that was cut
   * off is closed as `abandoned` and its writes rolled back (unless the
   * host chose `history: "latest"`); its message is re-queued right after.
   */
  | { type: "restored"; fromSeq: number; turns: number; requeued: number; history: Message[]; system?: string };

export type AgentEventType = AgentEvent["type"];

// ============================================================================
// Envelope
// ============================================================================

export interface EventEnvelope {
  /** Monotonic position in the log (1-based).  Continues across restores. */
  seq: number;
  /** Unique event id: `${run}-${seq}`.  (Named `eventId` because several
   *  payloads carry their own `id`, e.g. `tool_start.id`.) */
  eventId: string;
  /** Wall-clock ms. */
  ts: number;
  /** Id of the `EventLog` instance (process run) that appended the event. */
  run: string;
  /** Id of the agent that produced the event. */
  agent: string;
  /** Id of the message whose turn produced the event, or `null` outside a turn. */
  turn: string | null;
  /** Causal parent — `eventId` of the event that directly led to this one. */
  parent?: string;
}

/** A logged event: payload + envelope. */
export type LogEvent<T extends AgentEventType = AgentEventType> =
  Extract<AgentEvent, { type: T }> & EventEnvelope;

// The envelope is spread over the payload on append, so a payload field
// named like an envelope field would be silently overwritten.  Fail the
// build instead: every key of every payload must be disjoint from the
// envelope's keys.
type DistributedKeys<T> = T extends unknown ? keyof T : never;
type EnvelopeClash = DistributedKeys<AgentEvent> & keyof EventEnvelope;
const _noEnvelopeClash: [EnvelopeClash] extends [never] ? true : never = true;
void _noEnvelopeClash;

export type AgentEventListener = (event: LogEvent) => void;

// ---- Named per-variant aliases for consumers -------------------------------
//
// Pure type aliases — zero runtime cost.  Handlers registered with
// `agent.on(type, handler)` receive the alias *plus* the envelope.

export type MessageQueuedEvent   = Extract<AgentEvent, { type: "message_queued" }>;
export type TurnStartEvent       = Extract<AgentEvent, { type: "turn_start" }>;
export type TurnEndEvent         = Extract<AgentEvent, { type: "turn_end" }>;
export type BusyEvent            = Extract<AgentEvent, { type: "busy" }>;
export type IdleEvent            = Extract<AgentEvent, { type: "idle" }>;
export type QueueChangedEvent    = Extract<AgentEvent, { type: "queue_changed" }>;
export type UserMessageEvent     = Extract<AgentEvent, { type: "user_message" }>;
export type AssistantMessageEvent = Extract<AgentEvent, { type: "assistant_message" }>;
export type ToolMessageEvent     = Extract<AgentEvent, { type: "tool_message" }>;
export type HistoryReplacedEvent = Extract<AgentEvent, { type: "history_replaced" }>;
export type HistoryClearedEvent  = Extract<AgentEvent, { type: "history_cleared" }>;
export type SystemSetEvent       = Extract<AgentEvent, { type: "system_set" }>;
export type SystemRefreshedEvent = Extract<AgentEvent, { type: "system_refreshed" }>;
export type ToolsChangedEvent    = Extract<AgentEvent, { type: "tools_changed" }>;
export type LlmRequestEvent      = Extract<AgentEvent, { type: "llm_request" }>;
export type StreamChunkEvent     = Extract<AgentEvent, { type: "stream_chunk" }>;
export type StreamDoneEvent      = Extract<AgentEvent, { type: "stream_done" }>;
export type LlmResponseEvent     = Extract<AgentEvent, { type: "llm_response" }>;
export type LlmErrorEvent        = Extract<AgentEvent, { type: "llm_error" }>;
export type ToolStartEvent       = Extract<AgentEvent, { type: "tool_start" }>;
export type ToolDoneEvent        = Extract<AgentEvent, { type: "tool_done" }>;
export type RetryEvent           = Extract<AgentEvent, { type: "retry" }>;
export type MemoryEvent          = Extract<AgentEvent, { type: "memory" }>;
export type ConfirmRequestEvent  = Extract<AgentEvent, { type: "confirm_request" }>;
export type ConfirmResponseEvent = Extract<AgentEvent, { type: "confirm_response" }>;
export type AskRequestEvent      = Extract<AgentEvent, { type: "ask_request" }>;
export type AskResponseEvent     = Extract<AgentEvent, { type: "ask_response" }>;
export type SpawnStartEvent      = Extract<AgentEvent, { type: "spawn_start" }>;
export type SpawnDoneEvent       = Extract<AgentEvent, { type: "spawn_done" }>;
export type TaskCompleteEvent    = Extract<AgentEvent, { type: "task_complete" }>;
export type InterruptedEvent     = Extract<AgentEvent, { type: "interrupted" }>;
export type ErrorEvent           = Extract<AgentEvent, { type: "error" }>;
export type FatalEvent           = Extract<AgentEvent, { type: "fatal" }>;
export type HookErrorEvent       = Extract<AgentEvent, { type: "hook_error" }>;
export type RestoredEvent        = Extract<AgentEvent, { type: "restored" }>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Events that carry no state — pure progress signals.  The reducer ignores
 * them, so a store may drop them (`createJsonlEventStore(path, { filter })`)
 * without affecting `projectState`.
 */
const EPHEMERAL: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "busy",
  "idle",
  "queue_changed",
  "stream_chunk",
  "stream_done",
]);

export function isEphemeralEvent(event: { type: AgentEventType }): boolean {
  return EPHEMERAL.has(event.type);
}

/** Convert anything thrown into a plain, serialisable `ErrorInfo`. */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack && { stack: err.stack }) };
  }
  if (err && typeof err === "object" && "message" in err) {
    const o = err as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof o.name === "string" ? o.name : "Error",
      message: String(o.message),
      ...(typeof o.stack === "string" && { stack: o.stack }),
    };
  }
  return { name: "Error", message: String(err) };
}

/**
 * Make an event safe for `JSON.stringify`: `Error` instances become
 * `ErrorInfo`.  Everything else in the model is already plain data.
 */
export function serializeEvent(event: LogEvent): LogEvent {
  if ((event.type === "error" || event.type === "fatal") && event.error instanceof Error) {
    return { ...event, error: toErrorInfo(event.error) } as LogEvent;
  }
  return event;
}
