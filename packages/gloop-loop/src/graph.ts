/**
 * gloop-loop/graph — Project a (shared, possibly multi-log) log into the
 * agent graph.
 *
 * `projectState` answers "what is one agent's state".  `projectGraph`
 * answers "who talked to whom, and because of what": nodes are turn
 * *attempts* (one per `turn_start`, plus queued messages that never
 * started), edges are messages whose `cause` points into another attempt.
 * Fan-out is several edges out of one node; fan-in several edges into one.
 *
 * Nodes are derived from `projectState` per agent, so the turn lifecycle
 * (running / ok / error / interrupted / fatal / abandoned) has exactly one
 * definition — the reducer's.
 */

import type { AgentMessage, LogEvent } from "./events.js";
import { projectState, type TurnRecord } from "./state.js";

/** Merge event lists from one or more logs: dedupe by `eventId`, order by time then seq. */
export function mergeEvents(...lists: ReadonlyArray<ReadonlyArray<LogEvent>>): LogEvent[] {
  const byId = new Map<string, LogEvent>();
  for (const list of lists) for (const e of list) byId.set(e.eventId, e);
  return [...byId.values()].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
}

export interface TurnNode {
  /** `${agent}:${turn}` for the first attempt; `${agent}:${turn}#${n}` for re-runs after a restore. */
  key: string;
  agent: string;
  turn: string;
  /** 1 for the first attempt of a message, 2+ for re-queued attempts. */
  attempt: number;
  message: AgentMessage;
  status: TurnRecord["status"] | "queued";
  /** `eventId` of the `message_queued` event that created this attempt. */
  queuedEventId: string;
  startSeq?: number;
  endSeq?: number;
  summary?: string;
}

export interface MessageEdge {
  /** Node the causing event belongs to (undefined when the cause is outside any turn, or in a log not loaded). */
  from?: string;
  /** Node created by the message. */
  to: string;
  /** The event that caused the message (`message.cause.eventId`). */
  causeEventId: string;
  /** Type of the causing event, when it is in the log. */
  causeType?: string;
  /** The `message_queued` event that carries the edge. */
  viaEventId: string;
}

export interface AgentGraph {
  agents: string[];
  nodes: TurnNode[];
  edges: MessageEdge[];
  /** Nodes that were not caused by any other turn (user input, host code). */
  roots: string[];
}

export function projectGraph(events: Iterable<LogEvent>): AgentGraph {
  const all = [...events];
  const byId = new Map<string, LogEvent>();
  const queued = new Map<string, LogEvent<"message_queued">[]>(); // `${agent}:${msgId}` → queued events, in order
  for (const e of all) {
    byId.set(e.eventId, e);
    if (e.type === "message_queued") {
      const k = `${e.agent}:${e.message.id ?? `seq_${e.seq}`}`;
      queued.set(k, [...(queued.get(k) ?? []), e]);
    }
  }

  // The message_queued event that produced a given attempt: the last one
  // before its turn_start (or the last one at all for a queued message).
  const queuedFor = (agent: string, turn: string, beforeSeq: number | undefined): LogEvent<"message_queued"> | undefined => {
    const list = queued.get(`${agent}:${turn}`) ?? [];
    const eligible = beforeSeq === undefined ? list : list.filter((q) => q.seq < beforeSeq);
    return eligible[eligible.length - 1] ?? list[list.length - 1];
  };

  const nodes: TurnNode[] = [];
  const attempts = new Map<string, number>();
  const push = (agent: string, turn: string, message: AgentMessage, status: TurnNode["status"], t?: Partial<TurnRecord>) => {
    const n = (attempts.get(`${agent}:${turn}`) ?? 0) + 1;
    attempts.set(`${agent}:${turn}`, n);
    const q = queuedFor(agent, turn, t?.startSeq);
    nodes.push({
      key: n === 1 ? `${agent}:${turn}` : `${agent}:${turn}#${n}`,
      agent, turn, attempt: n, message, status,
      queuedEventId: q?.eventId ?? "",
      ...(t?.startSeq !== undefined && { startSeq: t.startSeq }),
      ...(t?.endSeq !== undefined && { endSeq: t.endSeq }),
      ...(t?.summary !== undefined && { summary: t.summary }),
    });
  };

  const agents = [...new Set(all.map((e) => e.agent))];
  for (const agent of agents) {
    const st = projectState(all, agent);
    for (const t of st.turns) push(agent, t.id, t.message, t.status, t);
    if (st.currentTurn) push(agent, st.currentTurn.id, st.currentTurn.message, "running", st.currentTurn);
    for (const m of st.inbox) push(agent, m.id ?? "", m, "queued");
  }
  nodes.sort((a, b) => (byId.get(a.queuedEventId)?.seq ?? 0) - (byId.get(b.queuedEventId)?.seq ?? 0));

  // The attempt of (agent, turn) that was live when event `seq` happened.
  const nodeAt = (agent: string, turn: string, seq: number): TurnNode | undefined =>
    nodes.filter((n) => n.agent === agent && n.turn === turn && n.startSeq !== undefined && n.startSeq <= seq && (n.endSeq === undefined || seq <= n.endSeq))[0]
    ?? nodes.filter((n) => n.agent === agent && n.turn === turn).at(-1);

  const edges: MessageEdge[] = [];
  const hasIncoming = new Set<string>();
  for (const node of nodes) {
    const cause = node.message.cause;
    if (!cause) continue;
    const causeEvent = byId.get(cause.eventId);
    const from = causeEvent && causeEvent.turn !== null ? nodeAt(causeEvent.agent, causeEvent.turn, causeEvent.seq)?.key : undefined;
    edges.push({
      ...(from && { from }),
      to: node.key,
      causeEventId: cause.eventId,
      ...(causeEvent && { causeType: causeEvent.type }),
      viaEventId: node.queuedEventId,
    });
    hasIncoming.add(node.key);
  }

  return {
    agents: [...new Set(nodes.map((n) => n.agent))],
    nodes,
    edges,
    roots: nodes.filter((n) => !hasIncoming.has(n.key)).map((n) => n.key),
  };
}

/** A log referenced from inside another log. */
export interface LinkedLog {
  agent?: string;
  log: string;
  /** The event that references it (`spawn_done` or the `message_queued` carrying the cause). */
  viaEventId: string;
  direction: "child" | "parent";
}

/**
 * Logs this log points at: children reported by `spawn_done.child.log`, and
 * parents referenced by a `message.cause.log`.  Load them, `mergeEvents`
 * with these, and `projectGraph` joins everything by `eventId`.
 */
export function linkedLogs(events: Iterable<LogEvent>): LinkedLog[] {
  const out: LinkedLog[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type === "spawn_done" && e.child?.log && !seen.has(`child:${e.child.log}`)) {
      seen.add(`child:${e.child.log}`);
      out.push({ agent: e.child.agent, log: e.child.log, viaEventId: e.eventId, direction: "child" });
    }
    const cause = e.type === "message_queued" ? e.message.cause : undefined;
    if (cause?.log && !seen.has(`parent:${cause.log}`)) {
      seen.add(`parent:${cause.log}`);
      out.push({ agent: cause.agent, log: cause.log, viaEventId: e.eventId, direction: "parent" });
    }
  }
  return out;
}

/** Render the graph as a small Mermaid flowchart (handy for debugging). */
export function graphToMermaid(graph: AgentGraph): string {
  const id = (k: string) => k.replace(/[^A-Za-z0-9_]/g, "_");
  const lines = ["flowchart LR"];
  for (const n of graph.nodes) {
    const label = `${n.agent} · ${n.turn}${n.attempt > 1 ? ` #${n.attempt}` : ""} (${n.status})`;
    lines.push(`  ${id(n.key)}["${label.replace(/"/g, "'")}"]`);
  }
  for (const e of graph.edges) {
    if (!e.from) continue;
    lines.push(`  ${id(e.from)} -->|${e.causeType ?? "cause"}| ${id(e.to)}`);
  }
  return lines.join("\n");
}
