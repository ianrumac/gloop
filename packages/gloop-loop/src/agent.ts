/**
 * AgentLoop — the high-level, actor-style entry point for gloop-loop.
 *
 * The loop is modeled as an **actor** with a fluent, chainable surface:
 *   - `start()` kicks off a single long-lived async loop.
 *   - `send(msg)` enqueues a message (does NOT auto-start).
 *   - `sendSync(msg)` enqueues, auto-starts, and awaits that turn's completion.
 *   - `on(type, handler)` subscribes to a specific event type with a typed
 *     handler.  `onEvent(listener)` subscribes to the full firehose.
 *   - `interrupt()` aborts the current turn; the loop keeps running.
 *   - `stop()` drains and tears down.
 *
 * @example Script — one message
 * ```ts
 * const agent = new AgentLoop({ provider, model, system });
 *
 * agent.on("stream_chunk", e => process.stdout.write(e.text));
 *
 * await agent.sendSync("What files are here?");
 * await agent.stop();
 * ```
 *
 * @example Pipeline — prepare then run
 * ```ts
 * const agent = new AgentLoop({ provider, model, system });
 *
 * agent
 *   .on("tool_done", e => console.log(e.ok ? "✓" : "✗", e.name))
 *   .on("task_complete", e => console.log("done:", e.summary))
 *   .send("read the spec")
 *   .send("write the code")
 *   .send("run the tests")
 *   .start();                 // now processing begins
 *
 * await agent.awaitIdle();    // all three turns finished
 * await agent.stop();
 * ```
 *
 * @example Interactive
 * ```ts
 * const agent = new AgentLoop({ provider, model, system })
 *   .onEvent(e => ui.dispatch(e))
 *   .start();
 *
 * // User submits:      agent.send(text);
 * // User hits escape:  agent.interrupt();
 * // User quits:        await agent.stop();
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
} from "./core/core.js";
import { manageContextFork } from "./defaults/context-manager.js";

// ============================================================================
// Message types — what you can send INTO the actor
// ============================================================================

export type AgentMessageRole = "user" | "system";

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
   *   messages:
   *
   *       agent
   *         .send("list the files")
   *         .send({ role: "system", content: "now be harsh" })
   *         .send("review the first one")
   *         .start();
   *
   *   "list the files" runs under the original system prompt; "review
   *   the first one" runs under "now be harsh".  Unlike
   *   `agent.setSystem(prompt)` — which takes effect immediately and
   *   races with whatever is already in the inbox — a system message
   *   slots into the inbox at a precise position.
   */
  role: AgentMessageRole;
  content: string;
}

// ============================================================================
// Event types — what the actor emits OUT
// ============================================================================

export type AgentEvent =
  /** A turn has been taken off the inbox and is about to be processed. */
  | { type: "turn_start"; message: AgentMessage }
  /** The current turn finished (normally, via error, or via interrupt). */
  | { type: "turn_end" }
  /** The loop picked up work — a turn is in flight. */
  | { type: "busy" }
  /** The loop finished all inbox work and is waiting. */
  | { type: "idle" }
  /** Inbox size changed (enqueue / dequeue). */
  | { type: "queue_changed"; pending: number }
  /** A streamed chunk of assistant text. */
  | { type: "stream_chunk"; text: string }
  /** The streaming assistant message finished (may be followed by tool calls). */
  | { type: "stream_done" }
  /** A tool invocation started.  `id` is stable through tool_done. */
  | { type: "tool_start"; id: string; name: string; preview: string }
  /** A tool invocation finished.  `id` matches the prior tool_start. */
  | { type: "tool_done"; id: string; name: string; ok: boolean; output: string }
  /** The agent wrote a memory entry. */
  | { type: "memory"; op: "remember" | "forget"; content: string }
  /** System prompt was refreshed (e.g. after Reload). */
  | { type: "system_refreshed" }
  /** The agent called CompleteTask / Done. */
  | { type: "task_complete"; summary: string }
  /** The current turn was interrupted by `interrupt()`. */
  | { type: "interrupted" }
  /**
   * The current turn failed with a non-abort, non-fatal error.  Always an
   * `Error` instance — non-Error throws are coerced at the emit site so
   * subscribers don't have to narrow `unknown`.
   */
  | { type: "error"; error: Error }
  /**
   * The current turn failed with an error the host classified as **fatal**
   * via `AgentLoopOptions.isFatal`.  When this fires, the actor has already
   * stopped processing: the inbox is cleared and the loop will exit on its
   * next iteration.  Use this for errors that require the host to tear
   * down and restart (e.g. a self-modifying agent that calls `Reboot`).
   */
  | { type: "fatal"; error: Error }
  /** The actor wants a yes/no confirmation.  Answer with `respondToConfirm`. */
  | { type: "confirm_request"; id: string; command: string }
  /** The actor wants a free-form answer.  Answer with `respondToAsk`. */
  | { type: "ask_request"; id: string; question: string };

export type AgentEventListener = (event: AgentEvent) => void;

// ---- Named per-variant aliases for consumers -------------------------------
//
// These are pure type aliases — zero runtime cost — extracted from the
// AgentEvent union so consumers can reference a specific variant by name
// anywhere TypeScript expects a type (handler signatures, React props,
// message bus adapters, log shippers, etc.):
//
//     import { type StreamChunkEvent, type ToolDoneEvent } from "@hypen-space/gloop-loop";
//     const onChunk = (e: StreamChunkEvent) => process.stdout.write(e.text);
//     const onTool  = (e: ToolDoneEvent)    => log({ tool: e.name, ok: e.ok });
//     agent.on("stream_chunk", onChunk).on("tool_done", onTool);
//
// The `on(type, handler)` method uses a string literal for runtime dispatch
// and the resulting handler parameter is narrowed to the matching alias
// automatically via `Extract<>` — so you never need to supply the type
// parameter explicitly.

export type TurnStartEvent       = Extract<AgentEvent, { type: "turn_start" }>;
export type TurnEndEvent         = Extract<AgentEvent, { type: "turn_end" }>;
export type BusyEvent            = Extract<AgentEvent, { type: "busy" }>;
export type IdleEvent            = Extract<AgentEvent, { type: "idle" }>;
export type QueueChangedEvent    = Extract<AgentEvent, { type: "queue_changed" }>;
export type StreamChunkEvent     = Extract<AgentEvent, { type: "stream_chunk" }>;
export type StreamDoneEvent      = Extract<AgentEvent, { type: "stream_done" }>;
export type ToolStartEvent       = Extract<AgentEvent, { type: "tool_start" }>;
export type ToolDoneEvent        = Extract<AgentEvent, { type: "tool_done" }>;
export type MemoryEvent          = Extract<AgentEvent, { type: "memory" }>;
export type SystemRefreshedEvent = Extract<AgentEvent, { type: "system_refreshed" }>;
export type TaskCompleteEvent    = Extract<AgentEvent, { type: "task_complete" }>;
export type InterruptedEvent     = Extract<AgentEvent, { type: "interrupted" }>;
export type ErrorEvent           = Extract<AgentEvent, { type: "error" }>;
export type FatalEvent           = Extract<AgentEvent, { type: "fatal" }>;
export type ConfirmRequestEvent  = Extract<AgentEvent, { type: "confirm_request" }>;
export type AskRequestEvent      = Extract<AgentEvent, { type: "ask_request" }>;

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
  /** Custom BuiltinIO for primitiveTools(). Only used when tools is not provided. */
  io?: BuiltinIO;
  /** Tools to use. Defaults to `primitiveTools(io)`. */
  tools?: ToolDefinition[];

  // ---- Injected dependencies ----
  //
  // All agent output is published via `onEvent(...)`.  The only callbacks the
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
   * agent's `Reboot` signal — see `wireRebootHandler` in `src/core/session.ts`.
   *
   * Return `false` (or omit) for normal per-turn errors: the actor keeps
   * running and processes the next queued message.
   */
  isFatal?: (error: Error) => boolean;

  /** Debug logger for internal events. */
  log?: (label: string, content: string) => void;

  // ---- Loop config ----
  /** Number of tool calls between automatic context prune. 0 disables. Default: 0 */
  contextPruneInterval?: number;
  /** Classify tool calls as spawn tasks. */
  classifySpawn?: LoopConfig["classifySpawn"];
  /**
   * Cap completion tokens per request.  Passed to the provider as max_tokens.
   * Default: 262144 (256k) — large enough that a long response with trailing
   * tool calls won't be truncated mid-generation.  Reduce for cheaper runs.
   */
  maxTokens?: number;
}

// ============================================================================
// AgentLoop
// ============================================================================

export class AgentLoop {
  readonly registry: ToolRegistry;
  readonly convo: AIConversation;
  readonly world: World;

  private options: AgentLoopOptions;
  private loopConfig: LoopConfig;
  private effects: Effects;

  // ---- Event bus ----
  //
  // Two parallel listener stores:
  //   - `listeners`       — full firehose, called on every event
  //   - `typedListeners`  — map from event type → set of handlers, called
  //                         only on matching events.  Populated by
  //                         `on(type, handler)`.
  // Both are Sets so the same function can register once per channel and be
  // removed by identity.
  private listeners = new Set<AgentEventListener>();
  private typedListeners = new Map<AgentEvent["type"], Set<(event: AgentEvent) => void>>();

  // ---- Inbox ----
  private inbox: AgentMessage[] = [];
  private inboxWakers: Array<() => void> = [];
  private running = false;
  private loopPromise: Promise<void> | null = null;

  // ---- Per-turn state ----
  private currentAbort: AbortController | null = null;
  private toolIdStack: string[] = [];
  private toolIdCounter = 0;
  private messageIdCounter = 0;

  // ---- Pending UI requests (for the default confirm/ask flow) ----
  private pendingConfirms = new Map<string, (ok: boolean) => void>();
  private pendingAsks = new Map<string, (answer: string) => void>();
  private requestCounter = 0;

  constructor(opts: AgentLoopOptions) {
    this.options = opts;

    // 1. Build tool registry — tools override defaults entirely
    this.registry = new ToolRegistry();
    const tools = opts.tools ?? primitiveTools(opts.io);
    for (const tool of tools) {
      this.registry.register(tool);
    }

    // 2. Build conversation
    const ai = new AI(opts.provider, opts.model);
    this.convo = ai.conversation({ model: opts.model, system: opts.system });
    this.convo.setMaxTokens(opts.maxTokens ?? 262_144);

    // 3. Build world.  `world.signal` is swapped in per-turn by runLoop() so
    //    `interrupt()` only aborts the current turn and not the whole actor.
    this.world = mkWorld(this.convo, this.registry);

    // 4. Build effects that route through the event bus.
    this.effects = this.buildEffects();

    // 5. Loop config
    this.loopConfig = {
      contextPruneInterval: opts.contextPruneInterval,
      classifySpawn: opts.classifySpawn,
    };
  }

  // --------------------------------------------------------------------------
  // Public — event subscription
  // --------------------------------------------------------------------------

  /**
   * Subscribe to the full event firehose.  Chainable.
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
   * narrowed to the matching variant automatically, so there is no `switch`
   * and no casting.
   *
   * @example
   * ```ts
   * agent
   *   .on("stream_chunk", (e) => process.stdout.write(e.text))
   *   .on("tool_done",    (e) => console.log(e.ok ? "✓" : "✗", e.name))
   *   .on("task_complete",(e) => console.log("summary:", e.summary))
   *   .start();
   * ```
   */
  on<T extends AgentEvent["type"]>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void,
  ): this {
    let set = this.typedListeners.get(type);
    if (!set) {
      set = new Set();
      this.typedListeners.set(type, set);
    }
    set.add(handler as (event: AgentEvent) => void);
    return this;
  }

  /**
   * Remove a typed listener registered with `on(type, handler)`.
   * Pass the SAME handler reference you subscribed with.  Chainable.
   */
  off<T extends AgentEvent["type"]>(
    type: T,
    handler: (event: Extract<AgentEvent, { type: T }>) => void,
  ): this {
    const set = this.typedListeners.get(type);
    if (set) {
      set.delete(handler as (event: AgentEvent) => void);
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
   * - An `id` is generated for the message if one was not provided, so that
   *   subscribers watching `turn_start` can correlate events to the message
   *   that caused them.
   * - **Does NOT auto-start the actor.**  If you want the work to run, call
   *   `.start()` (or use `sendSync` for the one-liner).  This lets you
   *   prepare a batch of messages before kicking off processing.
   *
   * Multiple messages can be queued while a turn is in progress — they are
   * drained in FIFO order.
   *
   * @example
   * ```ts
   * agent
   *   .send("read the spec")
   *   .send("write the code")
   *   .send("run the tests")
   *   .start();
   * await agent.awaitIdle();
   * ```
   */
  send(message: AgentMessage | string): this {
    this.enqueue(message);
    return this;
  }

  /**
   * Enqueue a message, auto-start the actor if needed, and resolve when
   * *that specific message*'s turn ends.
   *
   * - Auto-starts the actor (unlike `send`).
   * - Rejects with the underlying `Error` if the turn fails.
   * - Rejects with `AbortError` if the turn is interrupted.
   * - Other messages already queued ahead of this one are drained first; we
   *   wait for the `turn_end` whose `turn_start.message.id` matches the id
   *   of the message we just sent.
   *
   * @example
   * ```ts
   * await agent.sendSync("Deploy to staging");
   * await agent.stop();
   * ```
   */
  async sendSync(message: AgentMessage | string): Promise<void> {
    if (!this.running) this.start();
    const id = this.enqueue(message);
    let ours = false;
    let caught: Error | undefined;
    return new Promise<void>((resolve, reject) => {
      const handler = (event: AgentEvent): void => {
        if (event.type === "turn_start" && event.message.id === id) {
          ours = true;
          return;
        }
        if (!ours) return;
        if (event.type === "error" || event.type === "fatal") {
          caught = event.error;
        } else if (event.type === "interrupted") {
          caught = new AbortError();
        } else if (event.type === "turn_end") {
          this.offEvent(handler);
          if (caught) reject(caught);
          else resolve();
        }
      };
      this.onEvent(handler);
    });
  }

  /**
   * Resolve when the inbox is empty *and* no turn is in flight.
   *
   * - If the actor is not running, resolves immediately.
   * - If the actor is running with no work, resolves immediately.
   * - Otherwise waits for the next `idle` event.
   *
   * Common trap: if you call `awaitIdle()` **before** starting the loop,
   * it returns immediately — nothing was ever going to run.  Call `start()`
   * (or use `sendSync`) first.
   *
   * @example
   * ```ts
   * agent.send("a").send("b").send("c").start();
   * await agent.awaitIdle();   // all three turns have finished
   * ```
   */
  async awaitIdle(): Promise<void> {
    if (!this.running || (this.inbox.length === 0 && this.currentAbort === null)) {
      return;
    }
    return new Promise<void>((resolve) => {
      const handler = (event: AgentEvent): void => {
        if (event.type === "idle") {
          this.offEvent(handler);
          resolve();
        }
      };
      this.onEvent(handler);
    });
  }

  /**
   * Resolve on the next matching event.
   *
   * Pass a literal event `type` for type-narrowed access, or a predicate for
   * more specific matching.
   *
   * @example
   * ```ts
   * const done = await agent.nextEvent("task_complete");
   * console.log(done.summary);                              // typed as string
   *
   * const bashOk = await agent.nextEvent(
   *   (e) => e.type === "tool_done" && e.name === "Bash" && e.ok,
   * );
   * ```
   */
  nextEvent<T extends AgentEvent["type"]>(
    type: T,
  ): Promise<Extract<AgentEvent, { type: T }>>;
  nextEvent(filter: (event: AgentEvent) => boolean): Promise<AgentEvent>;
  nextEvent(
    typeOrFilter: string | ((event: AgentEvent) => boolean),
  ): Promise<AgentEvent> {
    const match = typeof typeOrFilter === "function"
      ? typeOrFilter
      : (e: AgentEvent) => e.type === typeOrFilter;
    return new Promise<AgentEvent>((resolve) => {
      const handler = (event: AgentEvent): void => {
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
    for (const [, resolve] of this.pendingConfirms) resolve(false);
    this.pendingConfirms.clear();
    for (const [, resolve] of this.pendingAsks) resolve("");
    this.pendingAsks.clear();
    return this;
  }

  /**
   * Stop the actor.  Interrupts the current turn and clears the inbox.
   * Returns a promise that resolves when the loop has exited.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.inbox.length = 0;
    this.interrupt();
    this.wakeInbox();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
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
    const resolve = this.pendingConfirms.get(id);
    if (resolve) {
      this.pendingConfirms.delete(id);
      resolve(ok);
    }
    return this;
  }

  /** Resolve a pending `ask_request` event.  Chainable. */
  respondToAsk(id: string, answer: string): this {
    const resolve = this.pendingAsks.get(id);
    if (resolve) {
      this.pendingAsks.delete(id);
      resolve(answer);
    }
    return this;
  }

  // --------------------------------------------------------------------------
  // Public — mutators (chainable)
  // --------------------------------------------------------------------------
  //
  // All of these can be called between turns — the underlying registry /
  // conversation is re-read at the start of the next LLM call, so changes
  // take effect immediately on the following turn without restarting the
  // actor.  Mid-turn changes land on the *next* turn, not the current one.

  /** Clear the conversation history. */
  clear(): this {
    this.convo.clear();
    this.world.toolCalls = 0;
    return this;
  }

  /** Register a tool.  Takes effect on the next turn. */
  addTool(tool: ToolDefinition): this {
    this.registry.register(tool);
    return this;
  }

  /**
   * Remove a tool by name.  No-op if the tool isn't registered.
   * Takes effect on the next turn.
   */
  removeTool(name: string): this {
    this.registry.unregister(name);
    return this;
  }

  /**
   * Replace the entire tool set atomically.  Existing tools are cleared
   * first, then the new list is registered.  Takes effect on the next turn.
   */
  setTools(tools: ToolDefinition[]): this {
    this.registry.clear();
    for (const tool of tools) this.registry.register(tool);
    return this;
  }

  /** Update the system prompt.  Takes effect on the next turn. */
  setSystem(prompt: string): this {
    this.convo.setSystem(prompt);
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
    this.emit({ type: "queue_changed", pending: this.inbox.length });
    this.wakeInbox();
    return id;
  }

  private emit(event: AgentEvent): void {
    // Snapshot both listener lists so a handler that unsubscribes (or
    // subscribes) mid-emit is safe.  Swallow any handler error — a broken
    // subscriber must not kill the loop.

    // 1. Firehose subscribers (`onEvent`).
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* ignore */ }
    }

    // 2. Typed subscribers (`on(type, handler)`) for this event's type.
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

      this.emit({ type: "busy" });
      this.emit({ type: "turn_start", message: msg });

      try {
        if (msg.role === "system") {
          // System messages update the conversation's system prompt and
          // do NOT call the LLM.  They still go through the normal
          // turn_start / turn_end lifecycle so `sendSync` and any other
          // per-turn correlation keeps working.
          this.convo.setSystem(msg.content);
          this.emit({ type: "system_refreshed" });
        } else {
          await runCore(msg.content, this.world, this.effects, this.loopConfig);
        }
      } catch (err) {
        if (err instanceof AbortError) {
          this.emit({ type: "interrupted" });
        } else {
          // Coerce non-Error throws so subscribers don't have to narrow `unknown`.
          const error = err instanceof Error ? err : new Error(String(err));
          if (this.options.isFatal?.(error)) {
            // Fatal error: stop the loop, clear the inbox, emit `fatal`.
            // The host listens for `fatal` and tears down.
            this.running = false;
            this.inbox.length = 0;
            this.emit({ type: "fatal", error });
          } else {
            this.emit({ type: "error", error });
          }
        }
      } finally {
        this.currentAbort = null;
        this.world.signal = undefined;
        this.emit({ type: "turn_end" });
      }

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

    return {
      streamChunk: (text) => this.emit({ type: "stream_chunk", text }),

      streamDone: () => this.emit({ type: "stream_done" }),

      toolStart: (name, preview) => {
        const id = this.nextToolId();
        this.toolIdStack.push(id);
        this.emit({ type: "tool_start", id, name, preview });
      },

      toolDone: (name, ok, output) => {
        const id = this.toolIdStack.pop() ?? this.nextToolId();
        this.emit({ type: "tool_done", id, name, ok, output });
      },

      confirm: opts.confirm ?? ((command) =>
        new Promise<boolean>((resolve) => {
          const id = `confirm_${++this.requestCounter}`;
          this.pendingConfirms.set(id, resolve);
          this.emit({ type: "confirm_request", id, command });
        })),

      ask: opts.ask ?? ((question) =>
        new Promise<string>((resolve) => {
          const id = `ask_${++this.requestCounter}`;
          this.pendingAsks.set(id, resolve);
          this.emit({ type: "ask_request", id, question });
        })),

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
          if (typeof next === "string") this.convo.setSystem(next);
        }
        this.emit({ type: "system_refreshed" });
      },

      manageContext: async (instructions) =>
        manageContextFork(this.convo, instructions, opts.log),

      complete: (summary) => this.emit({ type: "task_complete", summary }),

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

      log: opts.log,
    };
  }
}
