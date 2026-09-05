/**
 * @hypen-space/gloop-loop/replay — the pure, dependency-free half of the
 * library: event types, the in-memory log, the state reducer and the graph
 * projection.  Nothing here touches the network, the filesystem, or a
 * provider, so it bundles for the browser as-is.  Use it to build viewers,
 * analysers, or tests that only need to READ logs.
 */

export type {
  AgentMessage,
  AgentMessageRole,
  AgentEvent,
  AgentEventType,
  EventEnvelope,
  EventRef,
  ErrorInfo,
  LogEvent,
  TurnStatus,
} from "./events.js";
export { isEphemeralEvent, serializeEvent, toErrorInfo } from "./events.js";

export type { EventStore, EventLogOptions, AppendOptions, LogSubscriber } from "./log.js";
export { EventLog, MemoryEventStore, parseJsonlEvents } from "./log.js";

export type { AgentState, TurnRecord } from "./state.js";
export { initialState, reduce, projectState, messagesToRequeue } from "./state.js";

export type { AgentGraph, TurnNode, MessageEdge, LinkedLog } from "./graph.js";
export { projectGraph, graphToMermaid, linkedLogs, mergeEvents } from "./graph.js";
