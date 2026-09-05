/**
 * gloop-loop/hooks — Attach behaviour (and other agents) to the event log.
 *
 * Two mechanisms exist for reacting to an agent, and they are deliberately
 * different:
 *
 *   - **Interceptors** (`interceptors.ts`) wrap a boundary *synchronously in
 *     the call path*: they can rewrite inputs, short-circuit, retry.  Use
 *     them to *intercept*.
 *   - **Hooks** (this file) subscribe to the event log: they see every event
 *     after it happened and can do anything — including driving another
 *     `AgentLoop`.  A hook can never break the loop: a throw or rejection is
 *     captured as a `hook_error` event.  Use them to *attach*.
 *
 * Causality across agents is one explicit edge: `send(message, { cause })`.
 * `bridgeAgents` is the canonical hook built on it: when agent A emits a
 * matching event, send a message to agent B whose `cause` points back at
 * A's event, so the cross-agent edge is part of the graph.
 */

import type { AgentEventType, AgentMessage, EventRef, LogEvent } from "./events.js";

/** Options for `send`. */
export interface SendOptions {
  /**
   * The event this message is a reaction to.  Any `LogEvent` qualifies (it
   * carries `agent` and `eventId`); pass a bare `EventRef` with `log` to
   * point into another log.  Recorded as `message.cause` — the edge every
   * cross-agent relation in the graph is built from.
   */
  cause?: EventRef;
}

/** Something that can be hooked — the subset of `AgentLoop` hooks need. */
export interface HookTarget {
  readonly id: string;
  attach<T extends AgentEventType>(hook: AgentHook<T>): () => void;
  send(message: AgentMessage | string, options?: SendOptions): unknown;
}

/**
 * A hook.  When `types` is given, `handle` receives the narrowed union of
 * just those variants — `types: ["task_complete"]` gives `e.summary`.
 */
export interface AgentHook<T extends AgentEventType = AgentEventType> {
  /** Name used in `hook_error` events.  Default: `"anonymous"`. */
  name?: string;
  /** Only receive these event types.  Default: all. */
  types?: ReadonlyArray<T>;
  /**
   * `"self"` (default): only the attached agent's own events.
   * `"all"`: every event in the (possibly shared) log.
   */
  scope?: "self" | "all";
  /** The handler.  May be async; rejections become `hook_error` events. */
  handle: (event: LogEvent<T>, agent: HookTarget) => void | Promise<void>;
}

export interface BridgeOptions<T extends AgentEventType = AgentEventType> {
  /** Event type(s) on `from` that trigger a message to `to`. */
  on: T | ReadonlyArray<T>;
  /**
   * Build the message for `to`.  Return `null` to skip.  A string becomes a
   * user message.  Default: forward `task_complete.summary`, `error.message`,
   * or the event JSON.
   */
  map?: (event: LogEvent<T>, from: HookTarget) => AgentMessage | string | null;
  /** Hook name for diagnostics.  Default: `"bridge:<from>→<to>"`. */
  name?: string;
}

function defaultMap(event: LogEvent): string {
  switch (event.type) {
    case "task_complete":
      return event.summary;
    case "error":
    case "fatal":
      return `Agent ${event.agent} failed: ${event.error.message}`;
    default:
      return JSON.stringify(event);
  }
}

/**
 * Route events from one agent into another agent's inbox.
 *
 * @example  Reviewer that reacts whenever the coder completes a task
 * ```ts
 * const detach = bridgeAgents(coder, reviewer, {
 *   on: "task_complete",
 *   map: (e) => `Review this work: ${e.summary}`,
 * });
 * ```
 */
export function bridgeAgents<T extends AgentEventType>(
  from: HookTarget,
  to: HookTarget,
  options: BridgeOptions<T>,
): () => void {
  const types = Array.isArray(options.on) ? [...options.on] : [options.on as T];
  const map = options.map ?? ((e: LogEvent<T>) => defaultMap(e));
  return from.attach({
    name: options.name ?? `bridge:${from.id}→${to.id}`,
    types,
    handle: (event) => {
      const built = map(event as LogEvent<T>, from);
      if (built === null) return;
      to.send(typeof built === "string" ? { role: "user", content: built } : built, { cause: event });
    },
  });
}
