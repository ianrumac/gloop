/**
 * AgentLoop — the high-level, actor-style, event-sourced entry point.
 *
 * The loop is modeled as an **actor** with a fluent, chainable surface:
 *   - `start()` kicks off a single long-lived async loop.
 *   - `send(msg)` enqueues a message (does NOT auto-start).
 *   - `sendSync(msg)` enqueues, auto-starts, and awaits that turn's completion.
 *   - `on(type, handler)` subscribes to a specific event type with a typed
 *     handler.  `onEvent(listener)` subscribes to the full firehose.
 *   - `attach(hook)` attaches a hook (or another agent) that can never
 *     break the loop.
 *   - `interrupt()` aborts the current turn; the loop keeps running.
 *   - `stop()` drains and tears down.
 *
 * …and it is **event-sourced**: every input, output, tool call, memory op,
 * prompt change and lifecycle transition is appended to an `EventLog`
 * (`agent.log`).  `agent.snapshot()` folds the log back into state, and
 * `AgentLoop.resume({ store })` rebuilds an actor from a persisted log,
 * re-queueing whatever turn was cut off.
 *
 * @example Script — one message
 * ```ts
 * const agent = new AgentLoop({ provider, model, system });
 * agent.on("stream_chunk", e => process.stdout.write(e.text));
 * await agent.sendSync("What files are here?");
 * await agent.stop();
 * ```
 *
 * @example Durable + resumable
 * ```ts
 * const store = createJsonlEventStore(".gloop/session.jsonl");
 * const agent = await AgentLoop.resume({ provider, model, system, store });
 * agent.start();   // continues where the last process died
 * ```
 *
 * @example Attach a second agent
 * ```ts
 * bridgeAgents(coder, reviewer, { on: "task_complete", map: e => `Review: ${e.summary}` });
 * ```
 */

import type { AIProvider } from "./ai/types.js";
import { AI, type AIConversation } from "./ai/builder.js";
import { ToolRegistry } from "./tools/registry.js";
import { primitiveTools, type BuiltinIO } from "./tools/builtins.js";
import type { ToolDefinition } from "./tools/types.js";
import {
  run as runCore,
  mkWorld,
  AbortError,
  type Effects,
  type LoopConfig,
  type World,
  type SpawnResult,
  type CoreEvent,
} from "./core/core.js";
import { manageContextFork } from "./defaults/context-manager.js";
import { mergeSkillsIntoSystem } from "./skills.js";
import type { Skill } from "./skills.js";
import { withSpan } from "./trace.js";
import {
  type AgentEvent,
  type AgentEventType,
  type AgentMessage,
  type LogEvent,
  type AgentEventListener,
  type TurnStatus,
  toErrorInfo,
} from "./events.js";
import { EventLog, type EventStore } from "./log.js";
import { projectState, messagesToRequeue, type AgentState } from "./state.js";
import type { RetryConfig } from "./retry.js";
import type { AgentHook, HookTarget } from "./hooks.js";

// Re-exported so existing `import { AgentEvent } from "./agent.js"` keeps working.
export type {
  AgentMessage,
  AgentMessageRole,
  AgentEvent,
  AgentEventListener,
  LogEvent,
  MessageQueuedEvent,
  TurnStartEvent,
  TurnEndEvent,
  BusyEvent,
  IdleEvent,
  QueueChangedEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolMessageEvent,
  HistoryReplacedEvent,
  HistoryClearedEvent,
  SystemSetEvent,
  SystemRefreshedEvent,
  ToolsChangedEvent,
  LlmRequestEvent,
  StreamChunkEvent,
  StreamDoneEvent,
  LlmResponseEvent,
  LlmErrorEvent,
  ToolStartEvent,
  ToolDoneEvent,
  RetryEvent,
  MemoryEvent,
  ConfirmRequestEvent,
  ConfirmResponseEvent,
  AskRequestEvent,
  AskResponseEvent,
  SpawnStartEvent,
  SpawnDoneEvent,
  TaskCompleteEvent,
  InterruptedEvent,
  ErrorEvent,
  FatalEvent,
  HookErrorEvent,
  RestoredEvent,
} from "./events.js";

// ============================================================================
// Options
// ============================================================================

export interface AgentLoopOptions {
  /** AI provider (e.g. new OpenRouterProvider({ apiKey: "..." })) */
  provider: AIProvider;
  /** Model identifier (e.g. "anthropic/claude-sonnet-4") */
  model: string;
  /** System prompt */
  system?: string;
  /**
   * Optional skills (discovered by the host). Names and descriptions are merged
   * into the system prompt; `/skill-name` input is resolved to the skill body.
   */
  skills?: Skill[];
  /** Custom BuiltinIO for primitiveTools(). Only used when tools is not provided. */
  io?: BuiltinIO;
  /** Tools to use. Defaults to `primitiveTools(io)`. */
  tools?: ToolDefinition[];

  // ---- Event sourcing ----

  /** Agent id stamped on every event.  Default: `"agent"`. */
  id?: string;
  /**
   * Share an existing log (e.g. a parent agent's) so this agent's events
   * join the same graph.  Default: a fresh `EventLog`.
   */
  eventLog?: EventLog;
  /**
   * Persist the log.  Ignored when `eventLog` is given (configure the store
   * on the shared log instead).  Use `AgentLoop.resume` to rebuild from it.
   */
  store?: EventStore;
  /** Hooks attached at construction — same as calling `attach` for each. */
  hooks?: ReadonlyArray<AgentHook>;
  /**
   * Retry policies for the LLM and tool boundaries.  Off by default.
   *
   * @example
   * ```ts
   * retry: { llm: { attempts: 3, backoffMs: 500 } }
   * ```
   */
  retry?: RetryConfig;

  // ---- Injected dependencies ----
  //
  // All agent output is published via the event log.  The only callbacks the
  // actor still accepts are for behaviour that cannot be modelled as a pure
  // event — side-effecting writes (memory, system refresh) and subprocess
  // spawning.  For confirm / ask, prefer the default request-event flow
  // (`confirm_request` / `ask_request` + `respondToConfirm` / `respondToAsk`);
  // the direct callbacks below are kept only for non-interactive callers
  // (headless mode, tests) where there is no human to prompt.

  /**
   * Direct answer to a confirmation prompt.  If omitted (the default), the
   * actor emits a `confirm_request` event and the host answers via
   * `respondToConfirm(id, ok)`.
   */
  confirm?: (command: string) => Promise<boolean>;
  /**
   * Direct answer to a free-form question.  If omitted (the default), the
   * actor emits an `ask_request` event and the host answers via
   * `respondToAsk(id, answer)`.
   */
  ask?: (question: string) => Promise<string>;

  /**
   * Persist a memory entry.  **Default: no-op** — the lib does not write to
   * disk unless you explicitly opt in.  Use `createFileMemory()` for simple
   * file-backed memory, or pass your own persistence callback.
   *
   * The `memory` event still fires regardless, so subscribers know the
   * agent called Remember.
   */
  remember?: (content: string) => Promise<void>;
  /**
   * Remove a memory entry.  **Default: no-op.**  See `remember`.
   */
  forget?: (content: string) => Promise<void>;
  /**
   * Rebuild the system prompt.  May return the new prompt as a string, in
   * which case the actor wires it into the conversation for you.
   */
  refreshSystem?: () => Promise<string | void>;
  /** Install a new tool at runtime.  Default: "not available" stub. */
  installTool?: (source: string) => Promise<string>;
  /** Render a human-readable tool list.  Default: registry names. */
  listTools?: () => string;
  /** Spawn a subagent to handle a sub-task.  Default: "not configured" stub. */
  spawn?: (task: string) => Promise<SpawnResult>;

  /**
   * Classify a turn error as **fatal**.
   *
   * When the predicate returns `true`, the actor emits a `fatal` event
   * (not `error`), clears the inbox, and stops the loop so the host can
   * tear down cleanly.  The most common use is catching a self-modifying
   * agent's `Reboot` signal.
   *
   * Return `false` (or omit) for normal per-turn errors: the actor keeps
   * running and processes the next queued message.
   */
  isFatal?: (error: Error) => boolean;

  /** Debug logger — `(label, content)` pairs.  Not the event log (see `eventLog`). */
  log?: (label: string, content: string) => void;

  /**
   * Optional tracer.  When provided, every turn opens an `agent.turn` span
   * with child spans for each LLM call (`ai.stream`), tool execution
   * (`tool.{name}`), memory op (`memory.{op}`), and user request
   * (`request.confirm` / `request.ask`).  When omitted, tracing is a noop.
   */
  tracer?: import("./trace.js").Tracer;

  /**
   * Optional onion-style interceptors applied at every boundary
   * (LLM call, tool call, memory op, confirm/ask, spawn).  Each
   * interceptor can observe, mutate inputs, transform outputs,
   * short-circuit, or retry.  `interceptors[0]` is outermost.
   */
  interceptors?: ReadonlyArray<import("./interceptors.js").Interceptor>;

  // ---- Loop config ----
  /** Number of tool calls between automatic context prune. 0 disables. Default: 0 */
  contextPruneInterval?: number;
  /** Classify tool calls as spawn tasks. */
  classifySpawn?: LoopConfig["classifySpawn"];
  /**
   * Maximum LLM calls per turn — when set (> 0), stops a runaway
   * think→invoke loop with a `MaxIterationsError` instead of spinning
   * forever.  Default: 0 (disabled) — opt in per host.
   */
  maxIterations?: number;
  /**
   * Idle timeout for a single LLM stream (ms).  If the provider produces no
   * chunk for this long the stream is cancelled and the turn fails with an
   * `LlmIdleTimeoutError` instead of hanging the request.  0 disables.
   * Default: 120000 (2 minutes).
   */
  llmIdleTimeoutMs?: number;
  /**
   * Cap completion tokens per request.  Passed to the provider as max_tokens.
   * Default: 262144 (256k) — large enough that a long response with trailing
   * tool calls won't be truncated mid-generation.  Reduce for cheaper runs.
   */
  maxTokens?: number;
}

export interface HydrateOptions {
  /**
   * Re-queue the turn that was in flight plus everything still in the inbox.
   * Default: `true`.
   */
  requeue?: boolean;
  /**
   * `"committed"` (default): roll history back to the last turn boundary so a
   * half-finished turn is re-run from a consistent state.
   * `"latest"`: keep every recorded write, including a cut-off turn's.
   */
  history?: "committed" | "latest";
}

// ============================================================================
// AgentLoop
// ============================================================================

export class AgentLoop implements HookTarget {
  readonly id: string;
  readonly log: EventLog;
  readonly registry: ToolRegistry;
  readonly convo: AIConversation;
  readonly world: World;

  private options: AgentLoopOptions;
  private loopConfig: LoopConfig;
  private effects: Effects;
  private debugLog?: (label: string, content: string) => void;

  // ---- Event bus ----
  //
  // Two parallel listener stores:
  //   - `listeners`       — full firehose, called on every event
  //   - `typedListeners`  — map from event type → set of handlers, called
  //                         only on matching events.  Populated by
  //                         `on(type, handler)`.
  // Both are Sets so the same function can register once per channel and be
  // removed by identity.  They receive only THIS agent's events; use
  // `attach({ scope: "all" })` or `log.subscribe` for a shared log.
  private listeners = new Set<AgentEventListener>();
  private typedListeners = new Map<AgentEventType, Set<(event: LogEvent) => void>>();
  private detachLog: () => void;

  // ---- Inbox ----
  private inbox: AgentMessage[] = [];
  private inboxWakers: Array<() => void> = [];
  private running = false;
  private loopPromise: Promise<void> | null = null;

  // ---- Per-turn state ----
  private currentAbort: AbortController | null = null;
  private currentTurn: string | null = null;
  private turnStatus: TurnStatus = "ok";
  /** Id of the most recent event in the current turn — default causal parent. */
  private cursor: string | undefined;
  private toolIdStack: Array<{ id: string; eventId: string }> = [];
  private toolIdCounter = 0;
  private messageIdCounter = 0;
  private lastLlmRequestId: string | undefined;
  private queuedEventIds = new Map<string, string>();

  // ---- Pending UI requests (for the default confirm/ask flow) ----
  private pendingConfirms = new Map<string, { resolve: (ok: boolean) => void; eventId: string }>();
  private pendingAsks = new Map<string, { resolve: (answer: string) => void; eventId: string }>();
  private requestCounter = 0;

  constructor(opts: AgentLoopOptions) {
    this.options = opts;
    this.debugLog = opts.log;
    this.id = opts.id ?? "agent";
    this.log = opts.eventLog ?? new EventLog({ store: opts.store });

    // 1. Build tool registry — tools override defaults entirely
    this.registry = new ToolRegistry();
    const tools = opts.tools ?? primitiveTools(opts.io);
    for (const tool of tools) {
      this.registry.register(tool);
    }

    // 2. Build conversation
    const ai = new AI(opts.provider, opts.model);
    const system = mergeSkillsIntoSystem(opts.system, opts.skills ?? []);
    this.convo = ai.conversation({ model: opts.model, system });
    this.convo.setMaxTokens(opts.maxTokens ?? 262_144);

    // 3. Build world.  `world.signal` is swapped in per-turn by runLoop() so
    //    `interrupt()` only aborts the current turn and not the whole actor.
    //    `world.span` is also swapped in per-turn so each turn is a span tree.
    this.world = mkWorld(
      this.convo,
      this.registry,
      undefined,
      opts.tracer,
      opts.interceptors,
    );

    // 4. Build effects that route through the event log.
    this.effects = this.buildEffects();

    // 5. Loop config
    this.loopConfig = {
      contextPruneInterval: opts.contextPruneInterval,
      classifySpawn: opts.classifySpawn,
      maxIterations: opts.maxIterations,
      llmIdleTimeoutMs: opts.llmIdleTimeoutMs,
      skills: opts.skills,
      retry: opts.retry,
    };

    // 6. Dispatch this agent's events from the log to local listeners.
    this.detachLog = this.log.subscribe((event) => {
      if (event.agent === this.id) this.dispatch(event);
    });

    for (const hook of opts.hooks ?? []) this.attach(hook);

    // Record the initial configuration so a log starts self-describing.
    if (system !== undefined) this.emit({ type: "system_set", system });
    this.emit({ type: "tools_changed", names: this.registry.names() });
  }

  /**
   * Build an actor from a persisted log: loads the store, replays it into
   * the conversation, re-queues any cut-off turn, and returns the (not yet
   * started) agent.  New events continue in the same store.
   */
  static async resume(
    opts: AgentLoopOptions & HydrateOptions,
  ): Promise<AgentLoop> {
    const { requeue, history, ...rest } = opts;
    const log = rest.eventLog ?? new EventLog({ store: rest.store });
    await log.load();
    const agent = new AgentLoop({ ...rest, eventLog: log });
    if (log.size > 0) agent.hydrate(undefined, { requeue, history });
    return agent;
  }

  // --------------------------------------------------------------------------
  // Public — event sourcing
  // --------------------------------------------------------------------------

  /** Fold this agent's events into a state snapshot. */
  snapshot(): AgentState {
    return projectState(this.log.events(), this.id);
  }

  /**
   * Rebuild the conversation from events (default: this agent's log) and
   * re-queue unfinished work.  Emits `restored`.  Returns the projected state.
   */
  hydrate(events?: Iterable<LogEvent>, options: HydrateOptions = {}): AgentState {
    const state = events ? projectState(events, this.id) : this.snapshot();
    const useLatest = options.history === "latest";
    const history = useLatest ? state.history : state.committedHistory;
    const system = useLatest ? state.system : state.committedSystem;

    this.convo.setHistory(history);
    if (system !== undefined) this.convo.setSystem(system);
    this.world.toolCalls = 0;
    this.world.llmCalls = 0;
    this.world.pendingToolCalls = null;

    const requeue = options.requeue ?? true;
    const messages = requeue ? messagesToRequeue(state) : [];
    // Keep the message id counter ahead of anything already in the log so
    // new ids never collide with replayed ones.
    for (const m of messages) {
      const n = /^msg_(\d+)$/.exec(m.id ?? "");
      if (n) this.messageIdCounter = Math.max(this.messageIdCounter, Number(n[1]));
    }
    for (const t of state.turns) {
      const n = /^msg_(\d+)$/.exec(t.id);
      if (n) this.messageIdCounter = Math.max(this.messageIdCounter, Number(n[1]));
    }

    this.emit({
      type: "restored",
      fromSeq: state.lastSeq,
      turns: state.turns.length,
      requeued: messages.length,
      history: [...history],
      ...(system !== undefined && { system }),
    });
    for (const m of messages) this.enqueue(m);
    return state;
  }

  /** Resolve once every event so far has been handed to the store. */
  flush(): Promise<void> {
    return this.log.flush();
  }

  /**
   * Attach a hook.  Hooks see events after they are logged and may drive
   * other agents; a throw or rejection becomes a `hook_error` event instead
   * of breaking the loop.  Returns a detach function.
   */
  attach(hook: AgentHook): () => void {
    const name = hook.name ?? "anonymous";
    const types = hook.types ? new Set<string>(hook.types) : null;
    const all = hook.scope === "all";
    return this.log.subscribe((event) => {
      if (!all && event.agent !== this.id) return;
      if (types && !types.has(event.type)) return;
      const fail = (err: unknown) => {
        if (event.type === "hook_error") return; // never cascade
        this.emit({ type: "hook_error", hook: name, eventType: event.type, error: toErrorInfo(err) });
      };
      try {
        const r = hook.handle(event, this);
        if (r && typeof (r as Promise<void>).then === "function") {
          (r as Promise<void>).catch(fail);
        }
      } catch (err) {
        fail(err);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Public — event subscription
  // --------------------------------------------------------------------------

  /**
   * Subscribe to the full event firehose (this agent's events).  Chainable.
   *
   * Use `on(type, handler)` instead when you only care about one event type
   * — it avoids the `switch (event.type)` boilerplate and gives you a
   * narrowed handler parameter.
   */
  onEvent(listener: AgentEventListener): this {
    this.listeners.add(listener);
    return this;
  }

  /** Remove a firehose listener registered with `onEvent`.  Chainable. */
  offEvent(listener: AgentEventListener): this {
    this.listeners.delete(listener);
    return this;
  }

  /**
   * Subscribe to a specific event type.  The handler's event parameter is
   * narrowed to the matching variant (plus the log envelope).
   */
  on<T extends AgentEventType>(
    type: T,
    handler: (event: LogEvent<T>) => void,
  ): this {
    let set = this.typedListeners.get(type);
    if (!set) {
      set = new Set();
      this.typedListeners.set(type, set);
    }
    set.add(handler as (event: LogEvent) => void);
    return this;
  }

  /**
   * Remove a typed listener registered with `on(type, handler)`.
   * Pass the SAME handler reference you subscribed with.  Chainable.
   */
  off<T extends AgentEventType>(
    type: T,
    handler: (event: LogEvent<T>) => void,
  ): this {
    const set = this.typedListeners.get(type);
    if (set) {
      set.delete(handler as (event: LogEvent) => void);
      if (set.size === 0) this.typedListeners.delete(type);
    }
    return this;
  }

  // --------------------------------------------------------------------------
  // Public — actor lifecycle
  // --------------------------------------------------------------------------

  /** Start the actor's message loop.  Idempotent.  Chainable. */
  start(): this {
    if (this.running) return this;
    this.running = true;
    this.loopPromise = this.runLoop();
    return this;
  }

  /**
   * Enqueue a message for the actor to process.  Chainable.
   *
   * - A string is interpreted as `{ role: "user", content }`.
   * - An `id` is generated for the message if one was not provided.
   * - **Does NOT auto-start the actor.**  Call `.start()` (or use `sendSync`).
   */
  send(message: AgentMessage | string): this {
    this.enqueue(message);
    return this;
  }

  /**
   * Enqueue a message, auto-start the actor if needed, and resolve when
   * *that specific message*'s turn ends (and its events are flushed to the
   * store).  Rejects with the turn's error, or `AbortError` on interrupt.
   */
  async sendSync(message: AgentMessage | string): Promise<void> {
    if (!this.running) this.start();
    const id = this.enqueue(message);
    let ours = false;
    let caught: Error | undefined;
    return new Promise<void>((resolve, reject) => {
      const handler = (event: LogEvent): void => {
        if (event.type === "turn_start" && event.message.id === id) {
          ours = true;
          return;
        }
        if (!ours) return;
        if (event.type === "error" || event.type === "fatal") {
          caught = event.error instanceof Error ? event.error : Object.assign(new Error(event.error.message), { name: event.error.name });
        } else if (event.type === "interrupted") {
          caught = new AbortError();
        } else if (event.type === "turn_end") {
          this.offEvent(handler);
          // Settle only once the turn's events are durable in the store.
          const err = caught;
          this.flush().then(() => (err ? reject(err) : resolve()));
        }
      };
      this.onEvent(handler);
    });
  }

  /**
   * Resolve when the inbox is empty *and* no turn is in flight.
   * If the actor is not running (or running with no work) resolves immediately.
   */
  async awaitIdle(): Promise<void> {
    if (!this.running || (this.inbox.length === 0 && this.currentAbort === null)) {
      return;
    }
    return new Promise<void>((resolve) => {
      const handler = (event: LogEvent): void => {
        if (event.type === "idle") {
          this.offEvent(handler);
          resolve();
        }
      };
      this.onEvent(handler);
    });
  }

  /** Resolve on the next matching event (by type or predicate). */
  nextEvent<T extends AgentEventType>(type: T): Promise<LogEvent<T>>;
  nextEvent(filter: (event: LogEvent) => boolean): Promise<LogEvent>;
  nextEvent(
    typeOrFilter: string | ((event: LogEvent) => boolean),
  ): Promise<LogEvent> {
    const match = typeof typeOrFilter === "function"
      ? typeOrFilter
      : (e: LogEvent) => e.type === typeOrFilter;
    return new Promise<LogEvent>((resolve) => {
      const handler = (event: LogEvent): void => {
        if (match(event)) {
          this.offEvent(handler);
          resolve(event);
        }
      };
      this.onEvent(handler);
    });
  }

  /**
   * Interrupt the current turn.  The loop itself keeps running so the next
   * queued message will be picked up normally.  Chainable.
   */
  interrupt(): this {
    this.currentAbort?.abort();
    // Resolve any pending UI requests with deny/empty so the loop can unwind.
    for (const [id, p] of this.pendingConfirms) {
      this.emit({ type: "confirm_response", id, ok: false }, p.eventId);
      p.resolve(false);
    }
    this.pendingConfirms.clear();
    for (const [id, p] of this.pendingAsks) {
      this.emit({ type: "ask_response", id, answer: "" }, p.eventId);
      p.resolve("");
    }
    this.pendingAsks.clear();
    return this;
  }

  /**
   * Stop the actor.  Interrupts the current turn, clears the inbox, and
   * resolves once the loop has exited and the log is flushed.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      await this.flush();
      return;
    }
    this.running = false;
    this.inbox.length = 0;
    this.interrupt();
    this.wakeInbox();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    await this.flush();
  }

  /** Is the actor currently running? */
  isRunning(): boolean {
    return this.running;
  }

  /** Number of messages currently waiting in the inbox. */
  pending(): number {
    return this.inbox.length;
  }

  // --------------------------------------------------------------------------
  // Public — request responses (default confirm/ask flow)
  // --------------------------------------------------------------------------

  /** Resolve a pending `confirm_request` event.  Chainable. */
  respondToConfirm(id: string, ok: boolean): this {
    const p = this.pendingConfirms.get(id);
    if (p) {
      this.pendingConfirms.delete(id);
      this.emit({ type: "confirm_response", id, ok }, p.eventId);
      p.resolve(ok);
    }
    return this;
  }

  /** Resolve a pending `ask_request` event.  Chainable. */
  respondToAsk(id: string, answer: string): this {
    const p = this.pendingAsks.get(id);
    if (p) {
      this.pendingAsks.delete(id);
      this.emit({ type: "ask_response", id, answer }, p.eventId);
      p.resolve(answer);
    }
    return this;
  }

  // --------------------------------------------------------------------------
  // Public — mutators (chainable, each one logged)
  // --------------------------------------------------------------------------

  /** Clear the conversation history. */
  clear(): this {
    this.convo.clear();
    this.world.toolCalls = 0;
    this.world.llmCalls = 0;
    this.world.pendingToolCalls = null;
    this.emit({ type: "history_cleared" });
    return this;
  }

  /** Register a tool.  Takes effect on the next turn. */
  addTool(tool: ToolDefinition): this {
    this.registry.register(tool);
    this.emit({ type: "tools_changed", names: this.registry.names() });
    return this;
  }

  /** Remove a tool by name.  No-op if the tool isn't registered. */
  removeTool(name: string): this {
    if (this.registry.unregister(name)) {
      this.emit({ type: "tools_changed", names: this.registry.names() });
    }
    return this;
  }

  /** Replace the entire tool set atomically. */
  setTools(tools: ToolDefinition[]): this {
    this.registry.clear();
    for (const tool of tools) this.registry.register(tool);
    this.emit({ type: "tools_changed", names: this.registry.names() });
    return this;
  }

  /** Update the system prompt.  Takes effect on the next turn. */
  setSystem(prompt: string): this {
    this.convo.setSystem(prompt);
    this.emit({ type: "system_set", system: prompt });
    return this;
  }

  /**
   * Replace the conversation history wholesale (logged as `history_replaced`).
   * Prefer `hydrate` / `resume` for restoring from a log.
   */
  setHistory(history: import("./ai/types.js").Message[], reason = "host"): this {
    this.convo.setHistory(history);
    this.emit({ type: "history_replaced", history: [...history], reason });
    return this;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** Core enqueue step shared by `send` and `sendSync`.  Returns the id. */
  private enqueue(message: AgentMessage | string): string {
    const id = typeof message === "object" && message.id
      ? message.id
      : `msg_${++this.messageIdCounter}`;
    const msg: AgentMessage = typeof message === "string"
      ? { id, role: "user", content: message }
      : { ...message, id };
    this.inbox.push(msg);
    const queued = this.emit({ type: "message_queued", message: msg });
    this.queuedEventIds.set(id, queued.eventId);
    this.emit({ type: "queue_changed", pending: this.inbox.length });
    this.wakeInbox();
    return id;
  }

  /**
   * Append an event to the log.  `parent` defaults to the most recent event
   * of the current turn so a turn reads as a causal chain; pairs
   * (request/response, start/done) pass their explicit parent.
   */
  private emit<E extends AgentEvent>(payload: E, parent?: string): LogEvent {
    const event = this.log.append(payload, {
      agent: this.id,
      turn: this.currentTurn,
      parent: parent ?? (this.currentTurn ? this.cursor : undefined),
    });
    if (this.currentTurn) this.cursor = event.eventId;
    return event as LogEvent;
  }

  /** Deliver one of this agent's events to local listeners. */
  private dispatch(event: LogEvent): void {
    // Snapshot both listener lists so a handler that unsubscribes (or
    // subscribes) mid-emit is safe.  Swallow any handler error — a broken
    // subscriber must not kill the loop.
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* ignore */ }
    }
    const typed = this.typedListeners.get(event.type);
    if (typed) {
      for (const handler of [...typed]) {
        try { handler(event); } catch { /* ignore */ }
      }
    }
  }

  private wakeInbox(): void {
    const wakers = this.inboxWakers;
    this.inboxWakers = [];
    for (const w of wakers) w();
  }

  private takeFromInbox(): Promise<AgentMessage | null> {
    if (this.inbox.length > 0) {
      const msg = this.inbox.shift()!;
      this.emit({ type: "queue_changed", pending: this.inbox.length });
      return Promise.resolve(msg);
    }
    if (!this.running) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.inboxWakers.push(() => {
        if (!this.running) return resolve(null);
        const msg = this.inbox.shift() ?? null;
        if (msg) this.emit({ type: "queue_changed", pending: this.inbox.length });
        resolve(msg);
      });
    });
  }

  private async runLoop(): Promise<void> {
    this.emit({ type: "idle" });
    while (this.running) {
      const msg = await this.takeFromInbox();
      if (!msg || !this.running) break;

      // Fresh abort controller per turn — `interrupt()` only kills the turn,
      // not the whole loop.
      this.currentAbort = new AbortController();
      this.world.signal = this.currentAbort.signal;
      this.toolIdStack = [];
      this.turnStatus = "ok";

      this.emit({ type: "busy" });
      const turnId = msg.id ?? `msg_${++this.messageIdCounter}`;
      this.currentTurn = turnId;
      this.cursor = undefined;
      const queuedId = this.queuedEventIds.get(turnId);
      this.queuedEventIds.delete(turnId);
      this.emit({ type: "turn_start", message: msg }, queuedId);

      try {
        // Open the per-turn span; `withSpan` is a noop when no tracer.
        // Child spans inside `runCore` use `world.span` as their parent.
        await withSpan(
          this.options.tracer,
          "agent.turn",
          {
            attributes: {
              messageId: msg.id ?? "",
              role: msg.role,
              contentLength: msg.content.length,
            },
          },
          async (span) => {
            const previous = this.world.span;
            this.world.span = span;
            try {
              if (msg.role === "system") {
                // System messages update the conversation's system prompt and
                // do NOT call the LLM.  They still go through the normal
                // turn_start / turn_end lifecycle so `sendSync` and any other
                // per-turn correlation keeps working.
                this.convo.setSystem(msg.content);
                this.emit({ type: "system_set", system: msg.content });
                this.emit({ type: "system_refreshed" });
              } else {
                await runCore(msg.content, this.world, this.effects, this.loopConfig);
              }
            } finally {
              this.world.span = previous;
            }
          },
        );
      } catch (err) {
        if (err instanceof AbortError) {
          this.turnStatus = "interrupted";
          this.emit({ type: "interrupted" });
        } else {
          // Coerce non-Error throws so subscribers don't have to narrow `unknown`.
          const error = err instanceof Error ? err : new Error(String(err));
          if (this.options.isFatal?.(error)) {
            // Fatal error: stop the loop, clear the inbox, emit `fatal`.
            // The host listens for `fatal` and tears down.
            this.running = false;
            this.inbox.length = 0;
            this.turnStatus = "fatal";
            this.emit({ type: "fatal", error });
          } else {
            this.turnStatus = "error";
            this.emit({ type: "error", error });
          }
        }
      } finally {
        this.currentAbort = null;
        this.world.signal = undefined;
        this.emit({ type: "turn_end", status: this.turnStatus });
        this.currentTurn = null;
        this.cursor = undefined;
      }

      // A turn is only "done" once it is durable.
      await this.flush();

      if (this.running && this.inbox.length === 0) {
        this.emit({ type: "idle" });
      }
    }
  }

  private nextToolId(): string {
    return `tool_${++this.toolIdCounter}`;
  }

  private buildEffects(): Effects {
    const opts = this.options;

    const record = (event: CoreEvent): void => {
      switch (event.type) {
        case "llm_request": {
          const e = this.emit(event);
          this.lastLlmRequestId = e.eventId;
          return;
        }
        case "llm_response":
        case "llm_error":
          this.emit(event, this.lastLlmRequestId);
          return;
        default:
          this.emit(event);
      }
    };

    return {
      record,

      streamChunk: (text) => { this.emit({ type: "stream_chunk", text }, this.lastLlmRequestId); },

      streamDone: () => { this.emit({ type: "stream_done" }, this.lastLlmRequestId); },

      toolStart: (name, preview, args, callId) => {
        const id = this.nextToolId();
        const entry = { id, eventId: "" };
        this.toolIdStack.push(entry);
        entry.eventId = this.emit({
          type: "tool_start",
          id,
          name,
          preview,
          ...(args && { args }),
          ...(callId && { callId }),
        }).eventId;
      },

      toolDone: (name, ok, output) => {
        const started = this.toolIdStack.pop();
        const id = started?.id ?? this.nextToolId();
        this.emit({ type: "tool_done", id, name, ok, output }, started?.eventId || undefined);
      },

      confirm: (command) => {
        const id = `confirm_${++this.requestCounter}`;
        if (opts.confirm) {
          const req = this.emit({ type: "confirm_request", id, command });
          return opts.confirm(command).then((ok) => {
            this.emit({ type: "confirm_response", id, ok }, req.eventId);
            return ok;
          });
        }
        // Register the resolver BEFORE emitting: a listener may answer
        // synchronously from inside the `confirm_request` handler.
        return new Promise<boolean>((resolve) => {
          const entry = { resolve, eventId: "" };
          this.pendingConfirms.set(id, entry);
          entry.eventId = this.emit({ type: "confirm_request", id, command }).eventId;
        });
      },

      ask: (question) => {
        const id = `ask_${++this.requestCounter}`;
        if (opts.ask) {
          const req = this.emit({ type: "ask_request", id, question });
          return opts.ask(question).then((answer) => {
            this.emit({ type: "ask_response", id, answer }, req.eventId);
            return answer;
          });
        }
        return new Promise<string>((resolve) => {
          const entry = { resolve, eventId: "" };
          this.pendingAsks.set(id, entry);
          entry.eventId = this.emit({ type: "ask_request", id, question }).eventId;
        });
      },

      remember: async (content) => {
        if (opts.remember) await opts.remember(content);
        this.emit({ type: "memory", op: "remember", content });
      },

      forget: async (content) => {
        if (opts.forget) await opts.forget(content);
        this.emit({ type: "memory", op: "forget", content });
      },

      refreshSystem: async () => {
        if (opts.refreshSystem) {
          const next = await opts.refreshSystem();
          if (typeof next === "string") {
            const merged = mergeSkillsIntoSystem(next, opts.skills ?? []);
            this.convo.setSystem(merged);
            this.emit({ type: "system_set", system: merged });
          }
        }
        this.emit({ type: "system_refreshed" });
      },

      manageContext: async (instructions) =>
        manageContextFork(this.convo, instructions, this.debugLog, {
          eventLog: this.log,
          id: `${this.id}/context`,
          onReplaced: (history, removed) =>
            this.emit({ type: "history_replaced", history, reason: `context_pruned:${removed}` }),
        }),

      complete: (summary) => { this.emit({ type: "task_complete", summary }); },

      installTool: opts.installTool ?? (async () => "Tool installation not available"),

      listTools: opts.listTools ?? (() => {
        const names = this.registry.names();
        return `${names.length} tools available: ${names.join(", ")}`;
      }),

      spawn: opts.spawn ?? (async () => ({
        success: false,
        summary: "Spawn not configured — provide a spawn handler in options",
        exitCode: 1,
        stdout: "",
        stderr: "",
      })),

      log: this.debugLog,
    };
  }
}
