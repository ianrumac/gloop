/**
 * gloop-loop/state — Rebuild agent state from the event log.
 *
 * `projectState(events)` is a pure left fold of `reduce` over the log.  It
 * yields everything the actor needs to pick up where it left off:
 *
 *   - `history` / `system`      — the conversation as the model would see it
 *   - `committedHistory`        — the history as of the last turn boundary
 *                                 (the safe point to resume from after a crash)
 *   - `inbox` / `currentTurn`   — work that was queued or in flight
 *   - `turns`                   — every finished turn with its status
 *   - `memory`, `tools`         — what the agent remembered / had registered
 *   - `pendingConfirms/Asks`    — unanswered human-in-the-loop requests
 *
 * The reducer is immutable (every step returns a new object) so snapshots
 * taken at different points never alias each other.
 */

import type { Message } from "./ai/types.js";
import type { AgentMessage, LogEvent, TurnStatus } from "./events.js";

// ============================================================================
// Shapes
// ============================================================================

export interface TurnRecord {
  /** Message id (== `LogEvent.turn`). */
  id: string;
  message: AgentMessage;
  /** `seq` of the `turn_start` event. */
  startSeq: number;
  /** `seq` of the `turn_end` event; undefined while running. */
  endSeq?: number;
  /** `abandoned`: the turn was cut off (crash) and closed by a later restore. */
  status: TurnStatus | "running" | "abandoned";
  /** Summary passed to CompleteTask, if the turn completed a task. */
  summary?: string;
  /** Number of LLM calls made during the turn. */
  llmCalls: number;
  /** Number of tool invocations started during the turn. */
  toolCalls: number;
}

export interface AgentState {
  /** Agent id the state was projected for (or `"*"` when unfiltered). */
  agent: string;
  /** Live conversation history — includes writes from an unfinished turn. */
  history: Message[];
  /** History as of the last completed turn (or last out-of-turn change). */
  committedHistory: Message[];
  system?: string;
  committedSystem?: string;
  /** Remembered entries still present (forget removes matching entries). */
  memory: string[];
  /** Registered tool names as of the last `tools_changed`. */
  tools: string[];
  /** Messages queued but not yet started. */
  inbox: AgentMessage[];
  /** The turn that was in flight when the log ended, if any. */
  currentTurn: TurnRecord | null;
  /** Finished turns, oldest first. */
  turns: TurnRecord[];
  pendingConfirms: Array<{ id: string; command: string }>;
  pendingAsks: Array<{ id: string; question: string }>;
  /** Summaries from every `task_complete`. */
  completions: string[];
  /** Highest `seq` folded in. */
  lastSeq: number;
  /** Total events folded in. */
  eventCount: number;
}

export function initialState(agent = "*"): AgentState {
  return {
    agent,
    history: [],
    committedHistory: [],
    system: undefined,
    committedSystem: undefined,
    memory: [],
    tools: [],
    inbox: [],
    currentTurn: null,
    turns: [],
    pendingConfirms: [],
    pendingAsks: [],
    completions: [],
    lastSeq: 0,
    eventCount: 0,
  };
}

// ============================================================================
// Reducer
// ============================================================================

function withTurn(state: AgentState, patch: Partial<TurnRecord>): AgentState {
  if (!state.currentTurn) return state;
  return { ...state, currentTurn: { ...state.currentTurn, ...patch } };
}

/** Apply one event.  Pure — returns a new state. */
export function reduce(state: AgentState, event: LogEvent): AgentState {
  let next = step(state, event);
  next = { ...next, lastSeq: Math.max(next.lastSeq, event.seq), eventCount: next.eventCount + 1 };
  // Outside a turn every change is immediately "committed" — there is no
  // half-finished work to roll back past it.
  if (!next.currentTurn) {
    if (next.committedHistory !== next.history || next.committedSystem !== next.system) {
      next = { ...next, committedHistory: next.history, committedSystem: next.system };
    }
  }
  return next;
}

function step(s: AgentState, e: LogEvent): AgentState {
  switch (e.type) {
    // ---- inbox / turns -----------------------------------------------------
    case "message_queued":
      return { ...s, inbox: [...s.inbox, e.message] };

    case "turn_start": {
      const id = e.message.id ?? e.turn ?? `seq_${e.seq}`;
      return {
        ...s,
        inbox: s.inbox.filter((m) => m.id !== e.message.id),
        currentTurn: { id, message: e.message, startSeq: e.seq, status: "running", llmCalls: 0, toolCalls: 0 },
      };
    }

    case "turn_end": {
      if (!s.currentTurn) return s;
      const finished: TurnRecord = { ...s.currentTurn, endSeq: e.seq, status: e.status };
      return {
        ...s,
        currentTurn: null,
        turns: [...s.turns, finished],
        // Unanswered requests die with the turn.
        pendingConfirms: [],
        pendingAsks: [],
      };
    }

    case "task_complete":
      return { ...withTurn(s, { summary: e.summary }), completions: [...s.completions, e.summary] };

    // ---- history -----------------------------------------------------------
    case "user_message":
      return { ...s, history: [...s.history, { role: "user", content: e.content }] };

    case "assistant_message": {
      const msg: Message = e.toolCalls?.length
        ? { role: "assistant", content: e.content, toolCalls: e.toolCalls }
        : { role: "assistant", content: e.content };
      return { ...s, history: [...s.history, msg] };
    }

    case "assistant_tool_calls": {
      const last = s.history[s.history.length - 1];
      if (!last || last.role !== "assistant") return s;
      return { ...s, history: [...s.history.slice(0, -1), { ...last, toolCalls: e.toolCalls }] };
    }

    case "tool_message":
      return { ...s, history: [...s.history, { role: "tool", toolCallId: e.toolCallId, content: e.content }] };

    case "history_replaced":
      return { ...s, history: [...e.history] };

    case "history_cleared":
      return { ...s, history: [] };

    case "system_set":
      return { ...s, system: e.system };

    case "tools_changed":
      return { ...s, tools: [...e.names] };

    // ---- counters ----------------------------------------------------------
    case "llm_request":
      return withTurn(s, { llmCalls: (s.currentTurn?.llmCalls ?? 0) + 1 });

    case "tool_start":
      return withTurn(s, { toolCalls: (s.currentTurn?.toolCalls ?? 0) + 1 });

    // ---- memory ------------------------------------------------------------
    case "memory": {
      if (e.op === "remember") {
        const entry = e.content.trim();
        if (!entry || s.memory.includes(entry)) return s;
        return { ...s, memory: [...s.memory, entry] };
      }
      const needle = e.content.trim().toLowerCase();
      if (!needle) return s;
      return { ...s, memory: s.memory.filter((m) => !m.toLowerCase().includes(needle)) };
    }

    // ---- human-in-the-loop -------------------------------------------------
    case "confirm_request":
      return { ...s, pendingConfirms: [...s.pendingConfirms, { id: e.id, command: e.command }] };
    case "confirm_response":
      return { ...s, pendingConfirms: s.pendingConfirms.filter((c) => c.id !== e.id) };
    case "ask_request":
      return { ...s, pendingAsks: [...s.pendingAsks, { id: e.id, question: e.question }] };
    case "ask_response":
      return { ...s, pendingAsks: s.pendingAsks.filter((a) => a.id !== e.id) };

    // ---- outcomes (status is finalised by turn_end) ------------------------
    case "error":
      return withTurn(s, { status: "error" });
    case "fatal":
      return withTurn(s, { status: "fatal" });
    case "interrupted":
      return withTurn(s, { status: "interrupted" });

    // ---- restore -------------------------------------------------------------
    case "restored": {
      // Close a dangling turn, drop the stale inbox (the actor re-queues what
      // it wants right after this event), and adopt the rolled-back state.
      const turns = s.currentTurn
        ? [...s.turns, { ...s.currentTurn, endSeq: e.seq, status: "abandoned" as const }]
        : s.turns;
      return {
        ...s,
        turns,
        currentTurn: null,
        inbox: [],
        pendingConfirms: [],
        pendingAsks: [],
        history: [...e.history],
        system: e.system ?? s.system,
      };
    }

    // ---- everything else carries no state ----------------------------------
    default:
      return s;
  }
}

// ============================================================================
// Projection
// ============================================================================

/**
 * Fold a log into state.  Pass `agent` to project a single agent out of a
 * shared log; omit it to fold every event.
 */
export function projectState(events: Iterable<LogEvent>, agent?: string): AgentState {
  let state = initialState(agent ?? "*");
  for (const event of events) {
    if (agent !== undefined && event.agent !== agent) continue;
    state = reduce(state, event);
  }
  return state;
}

/**
 * The messages a resumed actor should re-run: the turn that was in flight
 * (its history writes are rolled back to `committedHistory`) followed by
 * everything still queued.
 */
export function messagesToRequeue(state: AgentState): AgentMessage[] {
  const out: AgentMessage[] = [];
  if (state.currentTurn) out.push(state.currentTurn.message);
  out.push(...state.inbox);
  return out;
}
