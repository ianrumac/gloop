/**
 * gloop-loop/log — The append-only event log.
 *
 * An `EventLog` is the single place every agent event goes through:
 *
 *   1. The envelope is stamped (seq / id / ts / run / agent / turn / parent).
 *   2. The event is kept in memory (`events()`), so the log can be projected
 *      into state at any time (`projectState`).
 *   3. Subscribers are notified synchronously — this is the hook point for
 *      UIs, other agents, tracing, anything.
 *   4. The event is handed to the optional `EventStore` for persistence.
 *      Writes are serialised in order; `flush()` resolves once every append
 *      so far has been persisted.
 *
 * One log can be shared by several agents (each event carries `agent`), so
 * a parent and the sub-agents it forks end up in one causal graph.
 */

import {
  type AgentEvent,
  type EventEnvelope,
  type LogEvent,
  serializeEvent,
} from "./events.js";

// ============================================================================
// Store
// ============================================================================

/** Pluggable persistence for the log.  Implement two methods. */
export interface EventStore {
  /** Persist one event.  Called in log order; the next call waits for this one. */
  append(event: LogEvent): void | Promise<void>;
  /** Return every event previously persisted, in order. */
  load(): LogEvent[] | Promise<LogEvent[]>;
}

/** In-memory store — useful for tests and for cloning a log. */
export class MemoryEventStore implements EventStore {
  readonly events: LogEvent[] = [];
  constructor(seed: LogEvent[] = []) {
    this.events.push(...seed);
  }
  append(event: LogEvent): void {
    // Keep what a real store would keep: plain data.
    this.events.push(serializeEvent(event));
  }
  load(): LogEvent[] {
    return [...this.events];
  }
}

// ============================================================================
// EventLog
// ============================================================================

export type LogSubscriber = (event: LogEvent) => void;

export interface EventLogOptions {
  /** Persistence.  Omit for an in-memory-only log. */
  store?: EventStore;
  /** Run id stamped on every event.  Default: random. */
  run?: string;
  /**
   * Called when the store rejects an append.  The event stays in memory and
   * the log keeps going — persistence failures never stop the agent.
   * Default: no-op.
   */
  onStoreError?: (error: unknown, event: LogEvent) => void;
}

export interface AppendOptions {
  /** Agent producing the event. */
  agent: string;
  /** Turn (message id) the event belongs to, or `null` outside a turn. */
  turn: string | null;
  /** Causal parent event id. */
  parent?: string;
}

function randomId(len = 6): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export class EventLog {
  readonly run: string;
  private readonly store?: EventStore;
  private readonly onStoreError: (error: unknown, event: LogEvent) => void;
  private readonly _events: LogEvent[] = [];
  private readonly ids = new Set<string>();
  private readonly subscribers = new Set<LogSubscriber>();
  private seq = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(options: EventLogOptions = {}) {
    this.store = options.store;
    this.run = options.run ?? randomId();
    this.onStoreError = options.onStoreError ?? (() => {});
  }

  /**
   * Seed the log from its store.  Safe to call once; subsequent calls are
   * no-ops.  Duplicate ids (a store that replays the same line twice) are
   * dropped; `seq` continues after the highest loaded value so ids stay
   * unique across restarts.
   */
  async load(): Promise<LogEvent[]> {
    if (this.loaded || !this.store) {
      this.loaded = true;
      return this.events();
    }
    this.loaded = true;
    const persisted = await this.store.load();
    for (const event of persisted) {
      if (!event || typeof event.seq !== "number" || typeof event.eventId !== "string") continue;
      if (this.ids.has(event.eventId)) continue;
      this.ids.add(event.eventId);
      this._events.push(event);
      if (event.seq > this.seq) this.seq = event.seq;
    }
    return this.events();
  }

  /** Stamp the envelope, keep, notify, persist.  Synchronous. */
  append<E extends AgentEvent>(payload: E, opts: AppendOptions): E & EventEnvelope {
    const seq = ++this.seq;
    const envelope: EventEnvelope = {
      seq,
      eventId: `${this.run}-${seq}`,
      ts: Date.now(),
      run: this.run,
      agent: opts.agent,
      turn: opts.turn,
      ...(opts.parent !== undefined && { parent: opts.parent }),
    };
    const event = { ...payload, ...envelope } as E & EventEnvelope;
    this._events.push(event as LogEvent);
    this.ids.add(event.eventId);

    // Notify.  Snapshot the set so subscribing / unsubscribing mid-emit is
    // safe, and never let a broken subscriber kill the loop.
    for (const sub of [...this.subscribers]) {
      try {
        sub(event as LogEvent);
      } catch {
        /* isolated */
      }
    }

    if (this.store) {
      const store = this.store;
      this.writeChain = this.writeChain
        .then(() => store.append(event as LogEvent))
        .catch((err) => this.onStoreError(err, event as LogEvent));
    }
    return event;
  }

  /** Subscribe to every event appended from now on.  Returns an unsubscribe fn. */
  subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Resolve when every append so far has been handed to the store. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  /** Copy of the in-memory events, optionally filtered. */
  events(filter?: (event: LogEvent) => boolean): LogEvent[] {
    return filter ? this._events.filter(filter) : [...this._events];
  }

  /** Events produced by one agent. */
  eventsFor(agent: string): LogEvent[] {
    return this._events.filter((e) => e.agent === agent);
  }

  /** Look an event up by `eventId`. */
  get(eventId: string): LogEvent | undefined {
    return this._events.find((e) => e.eventId === eventId);
  }

  /**
   * The event that caused `event`: its `parent` within the same turn, or —
   * for a `message_queued` that was sent in reaction to another agent's
   * event — that event, via `message.cause`.  Undefined at a root.
   */
  causeOf(event: LogEvent): LogEvent | undefined {
    if (event.parent) return this.get(event.parent);
    if (event.type === "message_queued" && event.message.cause) {
      return this.get(event.message.cause.eventId);
    }
    return undefined;
  }

  /**
   * Walk causes from an event back to its root (inclusive).  Follows
   * `parent` within a turn and `cause` across agents, so from a sub-agent's
   * tool call you reach the user message that ultimately triggered it.
   */
  ancestors(eventId: string): LogEvent[] {
    const out: LogEvent[] = [];
    let cur = this.get(eventId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.eventId)) {
      seen.add(cur.eventId);
      out.push(cur);
      cur = this.causeOf(cur);
    }
    return out;
  }

  /**
   * Direct effects of an event: events whose `parent` is `eventId`, plus
   * every `message_queued` (in any agent) whose `cause` is `eventId`.  A
   * fan-out to several agents shows up here as several children.
   */
  children(eventId: string): LogEvent[] {
    return this._events.filter(
      (e) =>
        e.parent === eventId ||
        (e.type === "message_queued" && e.message.cause?.eventId === eventId),
    );
  }

  /** Every event (transitively) caused by `eventId`, in log order. */
  descendants(eventId: string): LogEvent[] {
    const out: LogEvent[] = [];
    const seen = new Set<string>([eventId]);
    const frontier = [eventId];
    while (frontier.length) {
      const id = frontier.shift()!;
      for (const child of this.children(id)) {
        if (seen.has(child.eventId)) continue;
        seen.add(child.eventId);
        out.push(child);
        frontier.push(child.eventId);
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  get size(): number {
    return this._events.length;
  }

  get lastSeq(): number {
    return this.seq;
  }
}
