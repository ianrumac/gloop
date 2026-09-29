/**
 * gloop-loop/context — The agent's context as a graph, and the seam for
 * trimming it.
 *
 * `projectGraph` answers "who talked to whom".  `projectContext` answers
 * "what is in this agent's context right now, and where did each message
 * come from": nodes are the messages of the live history (in order), each
 * tied to the log event and turn that wrote it; edges tie an assistant's
 * tool calls to their `role: "tool"` responses.  `node.turn` joins to
 * `TurnNode.turn` in `projectGraph`, so a strategy can reason about whole
 * turns and cross-agent causality as well as single messages.
 *
 * A `ContextStrategy` is graph in, trimmed graph out:
 *
 * ```ts
 * const keepUserMessages: ContextStrategy = (graph) =>
 *   contextGraph(graph.agent, graph.nodes.filter((n) => n.message.role === "user"));
 *
 * new AgentLoop({ provider, model, contextStrategy: keepUserMessages });
 * ```
 *
 * The log itself is never trimmed — the actor flattens the returned graph
 * into the new history and records it as one `history_replaced` event.
 */

import type { AIProvider, Message } from "./ai/types.js";
import type { LogEvent } from "./events.js";
import type { EventLog } from "./log.js";
import { initialState, reduce } from "./state.js";

// ============================================================================
// Shapes
// ============================================================================

export interface ContextNode {
  /**
   * Unique within the graph.  The `eventId` of the event that appended the
   * message; `${eventId}#${index}` for a message introduced by a wholesale
   * replace (`history_replaced` / `restored`); `live#${index}` when the log
   * has no record of it.
   */
  id: string;
  message: Message;
  /** Turn (message id) that wrote it — joins to `TurnNode.turn`.  `null` outside a turn or when unknown. */
  turn: string | null;
  /** The log event the message came from, when known. */
  eventId?: string;
  seq?: number;
}

export interface ContextEdge {
  /** The assistant node carrying the tool calls. */
  from: string;
  /** The `role: "tool"` node answering one of them. */
  to: string;
  kind: "tool_result";
  toolCallId: string;
}

export interface ContextGraph {
  agent: string;
  /** The history, oldest first. */
  nodes: ContextNode[];
  /** Derived from `nodes` — see `contextGraph`. */
  edges: ContextEdge[];
}

/** What asked for the trim: the model's `ManageContext` call, or `contextPruneInterval`. */
export type ContextTrigger = "tool" | "auto";

export interface ContextStrategyContext {
  /** Id of the agent whose context is being trimmed. */
  agent: string;
  /** What to focus on — the model's `ManageContext` argument, or the auto-prune default. */
  instructions: string;
  trigger: ContextTrigger;
  /**
   * Every event in the (possibly shared) log.  `projectGraph(ctx.events)`
   * gives the cross-agent turn graph; `projectState(ctx.events, ctx.agent)`
   * the rest of the agent's state.
   */
  events: ReadonlyArray<LogEvent>;
  /** The log itself, for a strategy that forks an agent and wants its events in the same graph. */
  eventLog?: EventLog;
  /** The agent's provider / model, for a strategy that asks a model. */
  provider: AIProvider;
  model: string;
  /** Aborts when the turn is interrupted. */
  signal?: AbortSignal;
  /** Debug logger — `(label, content)` pairs. */
  log?: (label: string, content: string) => void;
}

/**
 * Decide what stays in context.  Receives the context graph, returns the
 * trimmed one: drop nodes, rewrite `node.message`, or add nodes
 * (`contextNode`) — e.g. a summary of what was dropped.  Only `nodes` (and
 * their order) are read back; `edges` are re-derived.  A tool-call group the
 * result only partly keeps is dropped as a unit (`closeToolGroups`).
 */
export type ContextStrategy = (
  graph: ContextGraph,
  ctx: ContextStrategyContext,
) => ContextGraph | Promise<ContextGraph>;

/** The outcome of running a strategy — see `trimContext`. */
export interface ContextTrim {
  graph: ContextGraph;
  /** `graph` flattened — what the conversation history becomes. */
  history: Message[];
  /** Input nodes missing from the result. */
  removed: number;
  /** Result nodes that were not in the input. */
  added: number;
  /** False when the resulting history is identical to the input's. */
  changed: boolean;
}

// ============================================================================
// Building graphs
// ============================================================================

let newNodeCounter = 0;

/** A node for a message the strategy itself introduces (a summary, a note). */
export function contextNode(message: Message, turn: string | null = null): ContextNode {
  return { id: `new#${++newNodeCounter}`, message, turn };
}

/** Assemble a graph from nodes, deriving the tool-call edges. */
export function contextGraph(agent: string, nodes: ReadonlyArray<ContextNode>): ContextGraph {
  const edges: ContextEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.message.role !== "assistant" || !node.message.toolCalls?.length) continue;
    // Same grouping the providers enforce: the assistant message plus the
    // consecutive tool responses that follow it.
    for (let j = i + 1; j < nodes.length && nodes[j]!.message.role === "tool"; j++) {
      edges.push({ from: node.id, to: nodes[j]!.id, kind: "tool_result", toolCallId: nodes[j]!.message.toolCallId ?? "" });
    }
  }
  return { agent, nodes: [...nodes], edges };
}

function sameMessage(a: Message, b: Message): boolean {
  return (
    a.role === b.role &&
    a.content === b.content &&
    (a.toolCallId ?? "") === (b.toolCallId ?? "") &&
    JSON.stringify(a.toolCalls ?? []) === JSON.stringify(b.toolCalls ?? [])
  );
}

/**
 * Carry provenance across a wholesale history change: walk the new history
 * and match each message, in order, against the nodes it replaces.  What
 * does not match is attributed to `source` (the replacing event).
 */
function align(old: ReadonlyArray<ContextNode>, history: ReadonlyArray<Message>, source?: LogEvent): ContextNode[] {
  const out: ContextNode[] = [];
  let cursor = 0;
  history.forEach((message, i) => {
    let at = -1;
    for (let j = cursor; j < old.length; j++) {
      if (sameMessage(old[j]!.message, message)) { at = j; break; }
    }
    if (at >= 0) {
      out.push({ ...old[at]!, message });
      cursor = at + 1;
    } else if (source) {
      out.push({ id: `${source.eventId}#${i}`, message, turn: source.turn, eventId: source.eventId, seq: source.seq });
    } else {
      out.push({ id: `live#${i}`, message, turn: null });
    }
  });
  return out;
}

/** A graph for a bare history — no log, so no provenance. */
export function contextFromHistory(history: ReadonlyArray<Message>, agent = "agent"): ContextGraph {
  return contextGraph(agent, align([], history));
}

/**
 * Project one agent's context out of a log.  History comes from the
 * reducer (`reduce`), so "what the model sees" has exactly one definition;
 * this only adds which event and turn each message came from.
 *
 * Pass the live `history` to pin the result to the conversation as it is
 * right now — messages the log does not know about become `live#n` nodes.
 */
export function projectContext(
  events: Iterable<LogEvent>,
  agent: string,
  history?: ReadonlyArray<Message>,
): ContextGraph {
  let state = initialState(agent);
  let nodes: ContextNode[] = [];
  for (const e of events) {
    if (e.agent !== agent) continue;
    const before = state.history;
    state = reduce(state, e);
    if (state.history === before) continue;
    const last = state.history[state.history.length - 1];
    if (last && state.history.length === nodes.length + 1 && (e.type === "user_message" || e.type === "assistant_message" || e.type === "tool_message")) {
      nodes = [...nodes, { id: e.eventId, message: last, turn: e.turn, eventId: e.eventId, seq: e.seq }];
    } else if (last && e.type === "assistant_tool_calls" && state.history.length === nodes.length) {
      // The calls were attached to the last assistant message — same node.
      nodes = [...nodes.slice(0, -1), { ...nodes[nodes.length - 1]!, message: last }];
    } else {
      nodes = align(nodes, state.history, e);
    }
  }
  if (history) nodes = align(nodes, history);
  return contextGraph(agent, nodes);
}

// ============================================================================
// Running a strategy
// ============================================================================

/**
 * Providers reject an assistant `toolCalls` message without its tool
 * responses (and vice versa), so each tool-call group of `input` lives or
 * dies as a unit: if `nodes` keeps only part of one, the rest goes too.
 */
export function closeToolGroups(input: ContextGraph, nodes: ReadonlyArray<ContextNode>): ContextNode[] {
  const groups = new Map<string, string[]>();
  for (const edge of input.edges) groups.set(edge.from, [...(groups.get(edge.from) ?? [edge.from]), edge.to]);
  const kept = new Set(nodes.map((n) => n.id));
  const drop = new Set<string>();
  for (const group of groups.values()) {
    if (group.some((id) => !kept.has(id))) for (const id of group) drop.add(id);
  }
  return drop.size === 0 ? [...nodes] : nodes.filter((n) => !drop.has(n.id));
}

/** Run `strategy` over `graph` and work out what it changed.  Pure apart from the strategy itself. */
export async function trimContext(
  strategy: ContextStrategy,
  graph: ContextGraph,
  ctx: ContextStrategyContext,
): Promise<ContextTrim> {
  const result = await strategy(graph, ctx);
  if (!result || !Array.isArray(result.nodes)) {
    throw new TypeError("contextStrategy must return a ContextGraph ({ agent, nodes, edges })");
  }
  for (const node of result.nodes) {
    if (!node?.message || typeof node.message.role !== "string" || typeof node.message.content !== "string") {
      throw new TypeError("contextStrategy returned a node without a valid message");
    }
  }
  const nodes = closeToolGroups(graph, result.nodes);
  const before = new Set(graph.nodes.map((n) => n.id));
  const after = new Set(nodes.map((n) => n.id));
  const changed =
    nodes.length !== graph.nodes.length ||
    nodes.some((n, i) => !sameMessage(n.message, graph.nodes[i]!.message));
  return {
    graph: contextGraph(graph.agent, nodes),
    history: nodes.map((n) => n.message),
    removed: graph.nodes.filter((n) => !after.has(n.id)).length,
    added: nodes.filter((n) => !before.has(n.id)).length,
    changed,
  };
}

/** The one-line result the model (and `tool_done`) sees. */
export function describeTrim(trim: ContextTrim, before: number): string {
  if (!trim.changed) return `Context reviewed: no messages pruned, ${before} remaining`;
  const added = trim.added > 0 ? `, added ${trim.added}` : "";
  return `Context pruned: removed ${trim.removed} messages${added}, ${trim.history.length} remaining`;
}

// ============================================================================
// A model-free strategy
// ============================================================================

/**
 * Keep only the messages written by the last `n` turns (plus anything whose
 * turn is unknown).  Deterministic and free — no model call.
 */
export function keepLastTurns(n: number): ContextStrategy {
  return (graph) => {
    const turns: string[] = [];
    for (const node of graph.nodes) {
      if (node.turn !== null && !turns.includes(node.turn)) turns.push(node.turn);
    }
    const keep = new Set(n > 0 ? turns.slice(-n) : []);
    return contextGraph(graph.agent, graph.nodes.filter((node) => node.turn === null || keep.has(node.turn)));
  };
}
