/**
 * gloop-loop/graph — Project a (shared) log into the agent graph.
 *
 * `projectState` answers "what is one agent's state".  `projectGraph`
 * answers "who talked to whom, and because of what": nodes are turns
 * (agent × message), edges are messages whose `cause` points into another
 * turn.  Fan-out (one event → messages to several agents) is several edges
 * out of one node; fan-in is several edges into one.
 *
 * Built purely from `message_queued`, `turn_start`, `turn_end` and
 * `task_complete` events, so it works on a store-filtered log too.
 */

import type { AgentMessage, LogEvent } from "./events.js";
import type { TurnRecord } from "./state.js";

export interface TurnNode {
  /** `${agent}:${turn}` — unique across agents in a shared log. */
  key: string;
  agent: string;
  turn: string;
  message: AgentMessage;
  status: TurnRecord["status"] | "queued";
  /** `eventId` of the `message_queued` event. */
  queuedEventId: string;
  startSeq?: number;
  endSeq?: number;
  summary?: string;
}

export interface MessageEdge {
  /** Node the causing event belongs to (undefined when the cause is outside any turn). */
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
  /** Turns that were not caused by any other turn (user input, host code). */
  roots: string[];
}

export function projectGraph(events: Iterable<LogEvent>): AgentGraph {
  const all = [...events];
  const byId = new Map<string, LogEvent>();
  for (const e of all) byId.set(e.eventId, e);

  const nodes = new Map<string, TurnNode>();
  const key = (agent: string, turn: string) => `${agent}:${turn}`;

  // 1. Every queued message is a node (it may or may not have run yet).
  for (const e of all) {
    if (e.type !== "message_queued") continue;
    const turn = e.message.id ?? `seq_${e.seq}`;
    nodes.set(key(e.agent, turn), {
      key: key(e.agent, turn),
      agent: e.agent,
      turn,
      message: e.message,
      status: "queued",
      queuedEventId: e.eventId,
    });
  }

  // 2. Lifecycle events refine the node.
  for (const e of all) {
    if (e.turn === null) continue;
    const node = nodes.get(key(e.agent, e.turn));
    if (!node) continue;
    switch (e.type) {
      case "turn_start":
        node.status = "running";
        node.startSeq = e.seq;
        break;
      case "turn_end":
        node.status = e.status;
        node.endSeq = e.seq;
        break;
      case "task_complete":
        node.summary = e.summary;
        break;
      case "restored":
        break;
      default:
        break;
    }
  }
  // A turn that was running when a `restored` event closed it is abandoned.
  for (const e of all) {
    if (e.type !== "restored") continue;
    for (const node of nodes.values()) {
      if (node.agent === e.agent && node.status === "running" && (node.startSeq ?? 0) < e.seq) {
        node.status = "abandoned";
        node.endSeq = e.seq;
      }
    }
  }

  // 3. Edges from `cause`.
  const edges: MessageEdge[] = [];
  const hasIncoming = new Set<string>();
  for (const node of nodes.values()) {
    const cause = node.message.cause;
    if (!cause) continue;
    const causeEvent = byId.get(cause.eventId);
    const from = causeEvent && causeEvent.turn !== null ? key(causeEvent.agent, causeEvent.turn) : undefined;
    edges.push({
      ...(from && { from }),
      to: node.key,
      causeEventId: cause.eventId,
      ...(causeEvent && { causeType: causeEvent.type }),
      viaEventId: node.queuedEventId,
    });
    hasIncoming.add(node.key);
  }

  const nodeList = [...nodes.values()].sort((a, b) => {
    const qa = byId.get(a.queuedEventId)!.seq;
    const qb = byId.get(b.queuedEventId)!.seq;
    return qa - qb;
  });

  return {
    agents: [...new Set(nodeList.map((n) => n.agent))],
    nodes: nodeList,
    edges,
    roots: nodeList.filter((n) => !hasIncoming.has(n.key)).map((n) => n.key),
  };
}

/** Render the graph as a small Mermaid flowchart (handy for debugging). */
export function graphToMermaid(graph: AgentGraph): string {
  const id = (k: string) => k.replace(/[^A-Za-z0-9_]/g, "_");
  const lines = ["flowchart LR"];
  for (const n of graph.nodes) {
    const label = `${n.agent} · ${n.turn} (${n.status})`;
    lines.push(`  ${id(n.key)}["${label.replace(/"/g, "'")}"]`);
  }
  for (const e of graph.edges) {
    if (!e.from) continue;
    lines.push(`  ${id(e.from)} -->|${e.causeType ?? "cause"}| ${id(e.to)}`);
  }
  return lines.join("\n");
}
