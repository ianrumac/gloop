/**
 * Viewer logic with no DOM dependency — parsing, layout, summaries.
 * `app.ts` renders; this module decides.  Unit-tested with `bun test`.
 */

import { mergeEvents, parseJsonlEvents, type AgentGraph, type LogEvent, type TurnNode } from "@hypen-space/gloop-loop/replay";

// Parsing and merging are the library's — one definition of a valid line,
// one ordering — re-exported here so the app has a single import.
export { mergeEvents, parseJsonlEvents as parseJsonl };

// ---------------------------------------------------------------------------
// Layout — layered DAG, longest-path layering, one column per layer
// ---------------------------------------------------------------------------

export const NODE_W = 210;
export const NODE_H = 78;
export const GAP_X = 90;
export const GAP_Y = 22;
export const PAD = 24;

export interface Placed {
  x: number;
  y: number;
  node: TurnNode;
}

export function layout(g: AgentGraph): Map<string, Placed> {
  const layer = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const e of g.edges) if (e.from) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  for (const n of g.nodes) layer.set(n.key, 0);
  // Relax up to |nodes| times — guards against accidental cycles.
  for (let i = 0; i < g.nodes.length; i++) {
    let changed = false;
    for (const n of g.nodes) {
      const l = Math.max(0, ...(incoming.get(n.key) ?? []).map((f) => (layer.get(f) ?? 0) + 1));
      if (l > (layer.get(n.key) ?? 0)) { layer.set(n.key, l); changed = true; }
    }
    if (!changed) break;
  }
  const columns = new Map<number, TurnNode[]>();
  for (const n of g.nodes) {
    const l = layer.get(n.key)!;
    columns.set(l, [...(columns.get(l) ?? []), n]);
  }
  const pos = new Map<string, Placed>();
  for (const [l, col] of columns) {
    col.forEach((n, i) => pos.set(n.key, { x: PAD + l * (NODE_W + GAP_X), y: PAD + i * (NODE_H + GAP_Y), node: n }));
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** `${agent}:${turn}` → [agent, turn]; agent ids may themselves contain ":". */
export function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * Events that belong to one turn attempt: its `message_queued`, then every
 * event stamped with the turn between its start and end.  With `node`
 * omitted (or a node without a seq range) all attempts are included.
 */
export function turnEvents(events: LogEvent[], key: string, node?: Pick<TurnNode, "queuedEventId" | "startSeq" | "endSeq">): LogEvent[] {
  const [agent, turn] = splitKey(key);
  const inRange = (e: LogEvent) =>
    !node || node.startSeq === undefined
      ? true
      : e.seq >= node.startSeq && (node.endSeq === undefined || e.seq <= node.endSeq);
  return events.filter((e) => {
    if (e.agent !== agent) return false;
    if (e.type === "message_queued") return node ? e.eventId === node.queuedEventId : e.message.id === turn;
    return e.turn === turn && inRange(e);
  });
}

/** One-line human summary of an event, for lists. */
export function summarize(e: LogEvent): string {
  switch (e.type) {
    case "message_queued": case "turn_start": return `${e.message.role}: ${e.message.content}`;
    case "turn_end": return e.status;
    case "user_message": return e.content;
    case "assistant_message": return e.content || (e.toolCalls ? `${e.toolCalls.length} tool call(s)` : "");
    case "assistant_tool_calls": return `${e.toolCalls.length} tool call(s): ${e.toolCalls.map((c) => c.function.name).join(", ")}`;
    case "tool_message": return `${e.toolCallId}: ${e.content}`;
    case "llm_request": return `${e.model} · ${e.historyLength} msgs · ${e.toolCount} tools`;
    case "llm_response": return `${e.finishReason ?? "?"} · ${e.text || ""}${e.toolCalls.length ? ` [+${e.toolCalls.length} calls]` : ""}`;
    case "llm_error": return `attempt ${e.attempt}: ${e.error.message}`;
    case "stream_chunk": return e.text;
    case "tool_start": return `${e.name}(${e.preview})`;
    case "tool_done": return `${e.name} ${e.ok ? "ok" : "failed"}: ${e.output}`;
    case "retry": return `${e.boundary}${e.name ? ":" + e.name : ""} attempt ${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms — ${e.error.message}`;
    case "memory": return `${e.op}: ${e.content}`;
    case "confirm_request": return e.command;
    case "confirm_response": return e.ok ? "approved" : "denied";
    case "ask_request": return e.question;
    case "ask_response": return e.answer;
    case "spawn_start": return e.task;
    case "spawn_done": return `${e.ok ? "ok" : "failed"} (${e.exitCode}) ${e.summary}${e.child ? ` → ${e.child.agent}` : ""}`;
    case "task_complete": return e.summary;
    case "system_set": return e.system;
    case "tools_changed": return e.names.join(", ");
    case "history_replaced": return `${e.reason} → ${e.history.length} messages`;
    case "error": case "fatal": return e.error.message;
    case "hook_error": return `${e.hook} on ${e.eventType}: ${e.error.message}`;
    case "restored": return `${e.turns} turns, ${e.requeued} requeued, ${e.history.length} messages`;
    default: return "";
  }
}

/** Colour token for a turn status. */
export const statusColor: Record<string, string> = {
  ok: "var(--ok)", error: "var(--err)", fatal: "var(--err)", interrupted: "var(--int)",
  abandoned: "var(--warn)", running: "var(--accent)", queued: "var(--queued)",
};
