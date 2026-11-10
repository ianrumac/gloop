/**
 * gloop-loop core — A recursive Lisp-style agent loop
 *
 * The fundamental insight: an agent is just a recursive function that
 * transforms (World, Input) -> (World', Action) until Action = Done.
 *
 * Each "form" is a pure description of what to do next.
 * The interpreter evaluates forms, producing new forms, until termination.
 */

import type { AIConversation } from "../ai/builder.js";
import type { JsonToolCall, Usage } from "../ai/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import { jsonToolCallsToToolCalls } from "../tools/parser.js";
import { requiresConfirmation } from "../tools/validator.js";
import { truncateOutput, DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "../tools/output.js";
import type { Skill } from "../skills.js";
import {
  formatSkillsListing,
  matchSkillSlash,
  skillInvocationToThinkInput,
  thinkInputFromSkillSubcommand,
} from "../skills.js";
import type { Span, Tracer } from "../trace.js";
import { NoopTracer, withSpan } from "../trace.js";
import type { AgentEvent, EventEnvelope, EventRef } from "../events.js";
import { toErrorInfo } from "../events.js";
import type { ContextTrigger } from "../context.js";
import type { RetryConfig } from "../retry.js";
import { withRetry, defaultRetryIf } from "../retry.js";
import { AbortError, raceAbort } from "./abort.js";
import type { Message } from "../ai/types.js";
import type {
  Interceptor,
  LlmCallContext,
  LlmCallResult,
  ToolCallContext,
  ToolCallResult,
  ConfirmContext,
  AskContext,
  MemoryContext,
  SpawnContext,
} from "../interceptors.js";
import { chainBoundary } from "../interceptors.js";

// ============================================================================
// FORMS — The S-expressions of our agent loop
// ============================================================================

/** A Form is a description of what to do next — pure data, no side effects */
export type Form =
  | { tag: "think"; input: string | null }                   // Send input to LLM (null = continue from history), get response
  | { tag: "invoke"; calls: ToolCall[]; then: Continuation } // Execute tools, continue with results
  | { tag: "confirm"; command: string; then: (ok: boolean) => Form }
  | { tag: "ask"; question: string; then: (answer: string) => Form }
  | { tag: "remember"; content: string; then: Form }
  | { tag: "forget"; content: string; then: Form }
  | { tag: "emit"; text: string; then: Form }                // Output text to user
  | { tag: "refresh" }                                       // Refresh system prompt, re-think
  | { tag: "done"; summary: string }                         // Terminal form
  | { tag: "seq"; forms: Form[] }                            // Sequence of forms
  | { tag: "nil" }                                            // Terminal no-op (monadic unit)
  | { tag: "install"; source: string }                       // /install slash command
  | { tag: "list-tools" }                                    // /tools slash command
  | { tag: "spawn"; task: string; then: (result: SpawnResult) => Form }; // Subagent

export interface SpawnResult {
  success: boolean;
  summary: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Agent id the child used for its own events, if it has a log. */
  agent?: string;
  /** Locator of the child's event log (e.g. its JSONL path). */
  log?: string;
}

/** What the interpreter tells a spawn handler about the spawning event. */
export interface SpawnCall {
  /** The `spawn_start` event — pass it to the child so it can record `cause`. */
  cause?: EventRef;
  /** Aborts when the turn is interrupted — kill the child when it fires. */
  signal?: AbortSignal;
}

/** Continuation: what to do with tool results */
export type Continuation = (results: ToolResult[]) => Form;

// ============================================================================
// FORM CONSTRUCTORS — Lisp-style convenience functions
// ============================================================================

export const Think = (input: string): Form =>
  ({ tag: "think", input });

/**
 * Continue the conversation from history without a new user message.
 * Used after tool results have been recorded as native `role: "tool"`
 * messages — the model responds to those directly.
 */
export const Continue = (): Form =>
  ({ tag: "think", input: null });

export const Invoke = (calls: ToolCall[], then: Continuation): Form =>
  ({ tag: "invoke", calls, then });

export const Confirm = (command: string, then: (ok: boolean) => Form): Form =>
  ({ tag: "confirm", command, then });

export const Ask = (question: string, then: (answer: string) => Form): Form =>
  ({ tag: "ask", question, then });

export const Remember = (content: string, then: Form): Form =>
  ({ tag: "remember", content, then });

export const Forget = (content: string, then: Form): Form =>
  ({ tag: "forget", content, then });

export const Emit = (text: string, then: Form): Form =>
  ({ tag: "emit", text, then });

export const Refresh = (): Form =>
  ({ tag: "refresh" });

export const Done = (summary: string): Form =>
  ({ tag: "done", summary });

export const Seq = (...forms: Form[]): Form =>
  ({ tag: "seq", forms });

export const Nil: Form = { tag: "nil" };

export const Install = (source: string): Form =>
  ({ tag: "install", source });

export const ListTools = (): Form =>
  ({ tag: "list-tools" });

export const Spawn = (task: string, then: (r: SpawnResult) => Form): Form =>
  ({ tag: "spawn", task, then });

// ============================================================================
// WORLD — The immutable state threaded through evaluation
// ============================================================================

export interface World {
  convo: AIConversation;
  registry: ToolRegistry;
  toolCalls: number;
  /** LLM calls made in the current `run()` — checked against `LoopConfig.maxIterations`. */
  llmCalls: number;
  /**
   * The assistant response whose tool calls are about to be invoked.
   * Set by `evalThink` when the model returns id-bearing tool calls;
   * consumed by `evalInvoke`, which records the assistant `toolCalls`
   * message and its `role: "tool"` responses into history atomically.
   */
  pendingToolCalls?: { text: string; calls: JsonToolCall[] } | null;
  signal?: AbortSignal;
  /** Optional tracer. When undefined, every `withSpan` short-circuits. */
  tracer?: Tracer;
  /**
   * Current span — child spans use this as parent. Mutated as the
   * interpreter descends into nested boundaries; `withWorldSpan` saves
   * and restores it.
   */
  span?: Span;
  /**
   * Optional interceptor chain applied at every interpreter boundary.
   * `interceptors[0]` is outermost. Empty / undefined → no overhead.
   */
  interceptors?: ReadonlyArray<Interceptor>;
  /**
   * Usage reported for the most recent LLM call, if any — the token figure
   * `LoopConfig.compactAtTokens` checks.  Cleared when a context strategy
   * rewrites history (the figure is stale until the next call).
   */
  lastUsage?: Usage;
  /**
   * Whether the token-based compaction trigger may fire.  Disarmed after a
   * compaction that changed nothing, re-armed once the context is back
   * under the threshold — so a strategy that cannot get under it does not
   * re-run every iteration.  Undefined means armed.
   */
  compactArmed?: boolean;
}

export { AbortError, raceAbort };

export const mkWorld = (
  convo: AIConversation,
  registry: ToolRegistry,
  signal?: AbortSignal,
  tracer?: Tracer,
  interceptors?: ReadonlyArray<Interceptor>,
): World => ({
  convo,
  registry,
  toolCalls: 0,
  llmCalls: 0,
  signal,
  tracer,
  interceptors,
});

/**
 * Thread a child span through the World during the lifetime of `fn`.
 * Saves/restores `world.span` so nested calls inherit the new span as
 * their parent automatically.
 */
async function withWorldSpan<T>(
  world: World,
  name: string,
  attributes: Record<string, string | number | boolean | undefined> | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  // Always pass a real Span (NoopTracer's when no tracer is configured) so
  // call sites can call setAttribute / recordException unconditionally.
  if (!world.tracer) {
    const noop = NoopTracer.startSpan(name, { attributes });
    try {
      return await fn(noop);
    } finally {
      noop.end();
    }
  }
  return withSpan(
    world.tracer,
    name,
    { parent: world.span, attributes },
    async (span) => {
      const previous = world.span;
      world.span = span;
      try {
        return await fn(span);
      } finally {
        world.span = previous;
      }
    },
  );
}

// ============================================================================
// EFFECTS — Side effects the interpreter can perform
// ============================================================================

/**
 * Events the interpreter itself produces for the log — every history
 * mutation and every boundary crossing.  Delivered through `Effects.record`.
 */
export type CoreEvent = Extract<
  AgentEvent,
  {
    type:
      | "user_message"
      | "assistant_message"
      | "assistant_tool_calls"
      | "tool_message"
      | "history_replaced"
      | "llm_request"
      | "llm_response"
      | "llm_error"
      | "retry"
      | "spawn_start"
      | "spawn_done";
  }
>;

export interface Effects {
  streamChunk: (text: string) => void;
  streamDone: () => void;
  toolStart: (name: string, preview: string, args?: Record<string, string>, callId?: string) => void;
  toolDone: (name: string, ok: boolean, output: string) => void;
  /**
   * Record an interpreter event (history writes, LLM request/response,
   * retries, spawns).  Optional — when omitted the interpreter still keeps
   * the conversation correct, it just isn't observable.  May return the
   * logged event (with envelope) so the interpreter can reference it.
   */
  record?: (event: CoreEvent) => (CoreEvent & EventEnvelope) | void;
  confirm: (command: string) => Promise<boolean>;
  ask: (question: string) => Promise<string>;
  remember: (content: string) => Promise<void>;
  forget: (content: string) => Promise<void>;
  refreshSystem: () => Promise<void>;
  /**
   * `trigger` says who asked: the model's ManageContext call (`"tool"`) or
   * an automatic trigger (`"auto"` — `contextPruneInterval` /
   * `compactAtTokens`).  `info.tokens` is the current context size estimate
   * (last reported prompt tokens, else a chars/4 estimate).
   */
  manageContext: (instructions: string, trigger?: ContextTrigger, info?: { tokens?: number }) => Promise<string>;
  complete: (summary: string) => void;
  installTool: (source: string) => Promise<string>;
  listTools: () => string;
  spawn: (task: string, call: SpawnCall) => Promise<SpawnResult>;
  /** Optional debug logger — receives (label, content) pairs */
  log?: (label: string, content: string) => void;
}

// ============================================================================
// LOOP CONFIGURATION — Optional hooks for customizing behavior
// ============================================================================

export interface LoopConfig {
  /**
   * Classify a tool call as a spawn task. Return the task string to spawn,
   * or null if the call is a regular tool invocation.
   * If not provided, no calls are treated as spawns.
   */
  classifySpawn?: (call: ToolCall) => string | null;

  /** Number of tool calls between automatic context prune. 0 disables. Default: 0 */
  contextPruneInterval?: number;

  /**
   * Run the context strategy automatically when the context reaches this
   * many tokens — the last request's `promptTokens` when the provider
   * reports usage, else a chars/4 estimate of the history.  Checked at the
   * same point as `contextPruneInterval` (after tool results are recorded,
   * before the next model call).  0 / undefined disables.
   */
  compactAtTokens?: number;

  /**
   * Cap on each tool result as the model sees it, in characters.  Longer
   * output keeps its head and tail with a marker in between
   * (`truncateOutput`).  `ToolDefinition.maxOutputChars` overrides it per
   * tool.  0 disables.  Default: 50_000.
   */
  maxToolOutputChars?: number;

  /**
   * Classify an error as fatal.  A tool that throws a fatal error is NOT
   * turned into a failed tool result (and is never retried): the error
   * propagates out of the turn, like one from the provider.
   */
  isFatal?: (error: Error) => boolean;

  /**
   * Maximum LLM calls per `run()` (one user turn).  When set (> 0), a
   * runaway think→invoke loop stops with a `MaxIterationsError` instead of
   * spinning forever.  Default: 0 (disabled) — opt in per host.
   */
  maxIterations?: number;

  /**
   * Idle timeout for a single LLM stream, in milliseconds.  If the provider
   * produces no chunk for this long, the stream is cancelled and the turn
   * fails with an error instead of hanging the whole request.  0 disables.
   * Default: 120000 (2 minutes).
   */
  llmIdleTimeoutMs?: number;

  /**
   * Skills for `/skill-name` resolution. If a user message starts with `/` and
   * matches a skill name, the skill body is sent as the turn input (after
   * substitutions). Should match the listing merged into the system prompt.
   */
  skills?: Skill[];

  /**
   * Retry policies.  `retry.llm` retries a failed model call (never one that
   * already streamed output — that would duplicate text; never an abort).
   * `retry.tool` retries tools that declare `retryable: true`.  Off by default.
   */
  retry?: RetryConfig;
}

/** Thrown when a turn exceeds `LoopConfig.maxIterations` LLM calls. */
export class MaxIterationsError extends Error {
  constructor(max: number) {
    super(`Agent loop exceeded ${max} LLM calls in a single turn — aborting to prevent a runaway loop`);
    this.name = "MaxIterationsError";
  }
}

/** Thrown when an LLM stream produces nothing for `llmIdleTimeoutMs`. */
export class LlmIdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM stream produced no output for ${ms}ms — cancelled to avoid hanging the request`);
    this.name = "LlmIdleTimeoutError";
  }
}

/** Race a promise against an idle timer.  0 or negative ms disables. */
function raceIdleTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmIdleTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Append one message to the conversation AND record the matching event.
 * Every history write in the interpreter goes through here so the log can
 * always rebuild `convo.getHistory()` exactly.
 */
function appendHistory(world: World, fx: Effects, message: Message, partial = false): void {
  world.convo.append(message);
  if (message.role === "user") {
    fx.record?.({ type: "user_message", content: message.content });
  } else if (message.role === "assistant") {
    fx.record?.({
      type: "assistant_message",
      content: message.content,
      ...(message.toolCalls?.length && { toolCalls: message.toolCalls }),
      ...(partial && { partial: true }),
    });
  } else if (message.role === "tool") {
    fx.record?.({ type: "tool_message", toolCallId: message.toolCallId ?? "", content: message.content });
  }
}

// ============================================================================
// TOOL CALL CONVERSION
// ============================================================================

/** SpawnResult → synthetic ToolResult for feeding back to the LLM */
function spawnToToolResult(r: SpawnResult): ToolResult {
  return {
    name: "Bash",
    output: r.success
      ? `Subagent task completed.\n${r.summary}`
      : `Subagent task failed (exit code: ${r.exitCode}).\n${r.summary}`,
    success: r.success,
  };
}

/**
 * Chain Spawn forms left-to-right, collecting each result, then hand all of
 * them to `then`.  The results reach the model the same way tool results
 * do — a spawn is a tool call whose "execute" is another agent.
 */
function chainSpawns(tasks: string[], then: Continuation): Form {
  const go = (i: number, acc: ToolResult[]): Form =>
    i >= tasks.length ? then(acc) : Spawn(tasks[i]!, (r) => go(i + 1, [...acc, spawnToToolResult(r)]));
  return go(0, []);
}

/**
 * Build a Form from a list of ToolCalls.
 *
 * `classifySpawn` is the LEGACY way to route subagent tasks: matching calls
 * become `Spawn` forms whose results are fed back as a synthetic user
 * message.  gloop-loop's own interpreter no longer passes it — `evalInvoke`
 * handles spawn-classified calls inline (natively recorded, visible as
 * tool_start / tool_done).  The parameter stays for hosts with their own
 * interpreter over the Form ADT (gloop-effect).
 */
export function toolCallsToForm(toolCalls: ToolCall[], classifySpawn?: (call: ToolCall) => string | null): Form {
  if (toolCalls.length === 0) return Nil;

  // Separate control forms from regular calls
  const completeCall = toolCalls.find(c => c.name === "CompleteTask");
  const regularCalls = toolCalls.filter(
    c => c.name !== "CompleteTask"
  );

  // Terminal forms: complete (optionally preceded by tool invocations)
  if (completeCall) {
    const summary = completeCall.args.summary ?? "Task complete";
    return regularCalls.length > 0 ? Invoke(regularCalls, () => Done(summary)) : Done(summary);
  }
  if (regularCalls.length === 0) return Nil;

  // Partition regular calls into plain tools and spawn tasks
  const plainCalls: ToolCall[] = [];
  const spawnTasks: string[] = [];
  for (const call of regularCalls) {
    const task = classifySpawn?.(call) ?? null;
    if (task) spawnTasks.push(task);
    else plainCalls.push(call);
  }

  // When every call carries a provider id, results are recorded natively in
  // history by evalInvoke (assistant toolCalls + role:"tool" responses), so
  // the follow-up think continues from history instead of receiving the
  // results as a synthetic user message.
  const native = regularCalls.every((c) => c.id);

  // No spawns: invoke tools, think with results
  if (spawnTasks.length === 0) {
    return Invoke(regularCalls, (results) =>
      native ? Continue() : Think(formatResults(results)));
  }

  // Mixed: invoke plain tools first, then the spawns; the model sees every
  // result (plain ones natively when ids are present, spawn ones as text).
  if (plainCalls.length > 0) {
    return Invoke(plainCalls, (toolResults) =>
      chainSpawns(spawnTasks, (spawnResults) =>
        Think(formatResults(native ? spawnResults : [...toolResults, ...spawnResults]))),
    );
  }

  // All spawns: run them, then think with their results.
  return chainSpawns(spawnTasks, (spawnResults) => Think(formatResults(spawnResults)));
}

/** Run the spawn boundary (interceptors + `fx.spawn`) with start/done events. */
async function runSpawn(world: World, fx: Effects, task: string): Promise<SpawnResult> {
  return withWorldSpan(world, "spawn", { taskLength: task.length }, async (span) => {
    const started = fx.record?.({ type: "spawn_start", task });
    const call: SpawnCall = {
      ...(started && { cause: { agent: started.agent, eventId: started.eventId } }),
      ...(world.signal && { signal: world.signal }),
    };
    const r = await chainBoundary(
      world.interceptors,
      "spawn",
      (ctx) => fx.spawn(ctx.task, call),
    )({ task } as SpawnContext);
    fx.record?.({
      type: "spawn_done",
      ok: r.success,
      exitCode: r.exitCode,
      summary: r.summary,
      ...(r.agent && { child: { agent: r.agent, ...(r.log && { log: r.log }) } }),
    });
    span.setAttribute("ok", r.success);
    span.setAttribute("exitCode", r.exitCode);
    return r;
  });
}

/** Run the memory boundary (interceptors + `fx.remember` / `fx.forget`). */
function runMemory(world: World, fx: Effects, op: "remember" | "forget", content: string): Promise<void> {
  return withWorldSpan(
    world,
    `memory.${op}`,
    { contentLength: content.length },
    () =>
      chainBoundary(world.interceptors, "memory", (ctx) =>
        ctx.op === "remember" ? fx.remember(ctx.content) : fx.forget(ctx.content),
      )({ op, content } as MemoryContext),
  );
}

/** Run the ask boundary (interceptors + `fx.ask`). */
function runAsk(world: World, fx: Effects, question: string): Promise<string> {
  return withWorldSpan(
    world,
    "request.ask",
    { question },
    async (span) => {
      const result = await chainBoundary(
        world.interceptors,
        "ask",
        (ctx) => fx.ask(ctx.question),
      )({ question } as AskContext);
      span.setAttribute("answerLength", result.length);
      return result;
    },
  );
}

export function formatResults(results: ToolResult[]): string {
  return results
    .map(r => {
      const status = r.success ? "success" : "error";
      return `<tool_result name="${r.name}" status="${status}">
${r.output}
</tool_result>`;
    })
    .join("\n\n");
}

// ============================================================================
// INTERPRETER — The recursive heart of the agent loop
// ============================================================================

/**
 * eval_ : Form × World × Effects → Promise<void>
 *
 * The trampoline-style interpreter. Recursively evaluates forms,
 * threading World through, performing Effects as needed.
 */
export async function eval_(
  form: Form,
  world: World,
  fx: Effects,
  config?: LoopConfig,
): Promise<void> {
  if (world.signal?.aborted) throw new AbortError();
  switch (form.tag) {
    case "nil":
      return;

    case "done":
      fx.complete(form.summary);
      return;

    case "emit":
      fx.streamChunk(form.text);
      fx.streamDone();
      return eval_(form.then, world, fx, config);

    case "remember":
      await runMemory(world, fx, "remember", form.content);
      return eval_(form.then, world, fx, config);

    case "forget":
      await runMemory(world, fx, "forget", form.content);
      return eval_(form.then, world, fx, config);

    case "confirm": {
      const ok = await withWorldSpan(
        world,
        "request.confirm",
        { command: form.command },
        async (span) => {
          const result = await chainBoundary(
            world.interceptors,
            "confirm",
            (ctx) => fx.confirm(ctx.command),
          )({ command: form.command } as ConfirmContext);
          span.setAttribute("approved", result);
          return result;
        },
      );
      const next = form.then(ok);
      return eval_(next, world, fx, config);
    }

    case "ask": {
      const answer = await runAsk(world, fx, form.question);
      const next = form.then(answer);
      return eval_(next, world, fx, config);
    }

    case "refresh":
      await fx.refreshSystem();
      return;

    case "seq":
      for (const f of form.forms) {
        await eval_(f, world, fx, config);
      }
      return;

    case "think":
      return evalThink(form.input, world, fx, config);

    case "invoke":
      return evalInvoke(form.calls, form.then, world, fx, config);

    case "install": {
      const result = await fx.installTool(form.source);
      fx.streamChunk(result);
      fx.streamDone();
      return;
    }

    case "list-tools": {
      fx.streamChunk(fx.listTools());
      fx.streamDone();
      return;
    }

    case "spawn": {
      const result = await runSpawn(world, fx, form.task);
      return eval_(form.then(result), world, fx, config);
    }
  }
}

/**
 * Think: stream LLM response via callModel's text/tool streams, then recurse.
 * `input === null` continues from history (after native tool results) without
 * appending a new user message.
 */
async function evalThink(
  input: string | null,
  world: World,
  fx: Effects,
  config?: LoopConfig,
): Promise<void> {
  fx.log?.("LLM_INPUT", input ?? "<continue from history>");

  // A previous think's pending tool calls are consumed by evalInvoke; any
  // leftover here belongs to a response whose calls never reached invoke
  // (all-spawn / CompleteTask-only) — drop it so it can't leak into a later
  // invoke's history writes.
  world.pendingToolCalls = null;

  // Runaway-loop guard: cap LLM calls per turn (opt-in, disabled by default).
  const maxIterations = config?.maxIterations ?? 0;
  world.llmCalls += 1;
  if (maxIterations > 0 && world.llmCalls > maxIterations) {
    throw new MaxIterationsError(maxIterations);
  }

  const idleMs = config?.llmIdleTimeoutMs ?? 120_000;

  // Set tools on the conversation for this request
  const jsonTools = world.registry.toJsonTools();
  world.convo.setJsonTools(jsonTools);

  // The user turn is written to history HERE (paired with a `user_message`
  // event) — never implicitly by the conversation object.
  if (input !== null) {
    appendHistory(world, fx, { role: "user", content: input });
  }

  const llmResult = await withWorldSpan(
    world,
    "ai.stream",
    {
      model: world.convo.model,
      historyLength: world.convo.getHistory().length,
      toolCount: jsonTools.length,
      inputLength: input?.length ?? 0,
    },
    async (span): Promise<LlmCallResult> => {
      const ctx: LlmCallContext = {
        input: input ?? "",
        model: world.convo.model,
        messages: world.convo.getHistory(),
        tools: jsonTools,
      };

      fx.record?.({
        type: "llm_request",
        model: world.convo.model,
        input,
        historyLength: ctx.messages.length,
        toolCount: jsonTools.length,
      });

      // The final handler runs the actual streaming call. Interceptors can
      // observe `ctx`, mutate `ctx.input`, short-circuit (return a synthetic
      // result), or wrap with retry / timing / caching logic.
      const result = await chainBoundary(
        world.interceptors,
        "llmCall",
        async (innerCtx): Promise<LlmCallResult> => {
          // If an interceptor rewrote the input, the rewritten text is what
          // the model must see — swap the user message we just appended, and
          // log the swap so replay stays exact.
          if (input !== null && innerCtx.input !== input) {
            const h = world.convo.getHistory();
            const last = h[h.length - 1];
            if (last && last.role === "user" && last.content === input) {
              h[h.length - 1] = { role: "user", content: innerCtx.input };
              world.convo.setHistory(h);
              fx.record?.({ type: "history_replaced", history: h, reason: "interceptor_rewrite" });
            }
          }

          // Retrying is only safe while nothing has reached the user yet —
          // a second attempt after streamed text would duplicate output.
          let streamedAny = false;
          const configured = config?.retry?.llm;
          const policy = configured
            ? {
                ...configured,
                retryIf: (err: unknown, attempt: number) =>
                  !streamedAny && (configured.retryIf ?? defaultRetryIf)(err, attempt),
              }
            : undefined;
          return withRetry(
            policy,
            async (attempt): Promise<LlmCallResult> => {
              let fullText = "";
              const stream = world.convo.request(world.signal ? { signal: world.signal } : undefined);
              try {
                const iter = stream.textStream[Symbol.asyncIterator]();
                while (true) {
                  const { done, value } = await raceIdleTimeout(
                    raceAbort(world.signal, iter.next()),
                    idleMs,
                  );
                  if (done) break;
                  // "" is a provider heartbeat (a chunk without text, e.g.
                  // tool-call argument deltas): it resets the idle timer
                  // above but is neither output nor history.
                  if (value === "") continue;
                  streamedAny = true;
                  fx.streamChunk(value);
                  fullText += value;
                }
                fx.streamDone();
                const calls = await raceIdleTimeout(stream.toolCalls, idleMs);
                const finishReason = await raceIdleTimeout(stream.finishReason, idleMs);
                // Usage is best-effort: a provider that fails to report it
                // must not fail the turn.
                const usage = stream.usage
                  ? await raceIdleTimeout(stream.usage, idleMs).catch(() => undefined)
                  : undefined;
                return { text: fullText, toolCalls: calls, finishReason, ...(usage && { usage }) };
              } catch (err) {
                if (err instanceof AbortError) {
                  await stream.cancel().catch(() => {});
                  if (fullText) {
                    appendHistory(world, fx, { role: "assistant", content: fullText }, true);
                  }
                } else {
                  if (err instanceof LlmIdleTimeoutError) {
                    await stream.cancel().catch(() => {});
                  }
                  fx.record?.({ type: "llm_error", error: toErrorInfo(err), attempt });
                }
                throw err;
              }
            },
            {
              signal: world.signal,
              onRetry: (info) =>
                fx.record?.({
                  type: "retry",
                  boundary: "llm",
                  attempt: info.attempt,
                  maxAttempts: info.maxAttempts,
                  delayMs: info.delayMs,
                  error: toErrorInfo(info.error),
                }),
            },
          );
        },
      )(ctx);

      fx.log?.("LLM_OUTPUT", result.text);
      fx.record?.({
        type: "llm_response",
        text: result.text,
        toolCalls: [...result.toolCalls],
        finishReason: result.finishReason,
        ...(result.usage && { usage: result.usage }),
      });
      if (result.usage) world.lastUsage = result.usage;
      span.setAttribute("outputLength", result.text.length);
      span.setAttribute("toolCallsRequested", result.toolCalls.length);
      span.setAttribute("finishReason", result.finishReason ?? "unknown");
      return result;
    },
  );

  // Record the assistant's text.  When tool calls follow, evalInvoke merges
  // them into this same message once the tools have run.
  if (llmResult.text) {
    appendHistory(world, fx, { role: "assistant", content: llmResult.text });
  }

  if (llmResult.toolCalls.length > 0) {
    // A response cut off by max_tokens usually ends mid-arguments — say so,
    // so the model retries with a smaller call instead of the same one.
    const truncated = llmResult.finishReason === "length";
    const toolCalls = jsonToolCallsToToolCalls(
      [...llmResult.toolCalls],
      world.registry,
    ).map((c) =>
      truncated && c.parseError !== undefined
        ? { ...c, parseError: `${c.parseError}; the response hit the max_tokens limit, so the arguments were probably cut off — split large content into smaller calls` }
        : c,
    );
    fx.log?.("TOOL_CALLS", JSON.stringify(toolCalls));
    // Stash the response so evalInvoke can record the assistant's tool calls
    // and their results natively in history.  Only when every call has a
    // provider id — otherwise there is nothing to correlate results against.
    if (llmResult.toolCalls.every((c) => c.id)) {
      world.pendingToolCalls = { text: llmResult.text, calls: [...llmResult.toolCalls] };
    }
    const nextForm = toolCallsToForm(toolCalls);
    return eval_(nextForm, world, fx, config);
  }

  return;
}

/**
 * Record the assistant's pending tool calls and their results as native
 * history messages: one assistant message carrying `toolCalls`, followed by
 * one `role: "tool"` response per call id.
 *
 * The streaming wrapper in `AIConversation` has already pushed the
 * assistant's TEXT (when non-empty); the toolCalls are merged into that
 * message so the response stays a single assistant turn.  Calls the
 * interpreter handles outside evalInvoke (CompleteTask, spawn-classified
 * tasks) — or that never ran because the turn was cut short — get
 * `unanswered` as their response so the provider never sees an unanswered
 * tool call id.
 */
function recordNativeToolMessages(
  world: World,
  fx: Effects,
  results: ToolResult[],
  unanswered = "(handled by the host — no tool output)",
): void {
  const pending = world.pendingToolCalls;
  if (!pending) return;
  world.pendingToolCalls = null;

  const h = world.convo.getHistory();
  const last = h[h.length - 1];
  if (last && last.role === "assistant" && last.content === pending.text && !last.toolCalls) {
    h[h.length - 1] = { ...last, toolCalls: pending.calls };
    world.convo.setHistory(h);
    fx.record?.({ type: "assistant_tool_calls", toolCalls: pending.calls });
  } else {
    appendHistory(world, fx, { role: "assistant", content: pending.text, toolCalls: pending.calls });
  }

  const byId = new Map(results.filter((r) => r.id).map((r) => [r.id!, r]));
  for (const call of pending.calls) {
    const r = byId.get(call.id);
    appendHistory(world, fx, {
      role: "tool",
      toolCallId: call.id,
      content: r
        ? (r.success ? r.output : `Error: ${r.output}`)
        : unanswered,
    });
  }
}

/** Instructions handed to the context strategy by the automatic triggers. */
const AUTO_PRUNE_INSTRUCTIONS =
  "Prune old tool results and intermediate outputs. Keep the current task goal, recent results, and any information the agent is actively using.";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Is `err` one that must unwind the turn rather than become a tool result? */
function mustPropagate(err: unknown, config?: LoopConfig): boolean {
  return err instanceof AbortError || (err instanceof Error && (config?.isFatal?.(err) ?? false));
}

/** Rough token count of the conversation (chars / 4) — used when the provider reports no usage. */
function estimateTokens(world: World): number {
  let chars = world.convo.getSystem()?.length ?? 0;
  for (const m of world.convo.getHistory()) {
    chars += m.content.length;
    for (const tc of m.toolCalls ?? []) chars += tc.function.name.length + tc.function.arguments.length;
  }
  return Math.ceil(chars / 4);
}

/** The context size the compaction trigger compares against. */
function contextTokens(world: World): number {
  return world.lastUsage?.promptTokens ?? estimateTokens(world);
}

/** Did a context strategy change the history?  (`getHistory` copies the array, not the messages.) */
function historyChanged(before: ReadonlyArray<Message>, after: ReadonlyArray<Message>): boolean {
  return before.length !== after.length || before.some((m, i) => m !== after[i]);
}

/**
 * Run `fx.manageContext`, clearing the stale usage figure when it rewrote
 * history.  Returns whether it did.
 */
async function runManageContext(
  world: World,
  fx: Effects,
  instructions: string,
  trigger: ContextTrigger,
  tokens: number,
): Promise<{ output: string; changed: boolean }> {
  const before = world.convo.getHistory();
  const output = await fx.manageContext(instructions, trigger, { tokens });
  const changed = historyChanged(before, world.convo.getHistory());
  if (changed) world.lastUsage = undefined;
  return { output, changed };
}

/**
 * Automatic context compaction, run at the safe point after a batch of tool
 * results is recorded: every `contextPruneInterval` tool calls, and when the
 * context reaches `compactAtTokens`.  A failing strategy is reported as a
 * failed `ManageContext` tool_done and the turn continues.
 */
async function autoCompact(world: World, fx: Effects, config: LoopConfig | undefined, callCount: number): Promise<void> {
  const interval = config?.contextPruneInterval ?? 0;
  const threshold = config?.compactAtTokens ?? 0;
  world.toolCalls += callCount;

  let reason: string | null = null;
  if (interval > 0 && world.toolCalls >= interval) {
    world.toolCalls = 0;
    reason = `auto-pruning after ${interval} tool calls`;
  }
  let tokens: number | undefined;
  if (threshold > 0) {
    tokens = contextTokens(world);
    if (tokens < threshold) world.compactArmed = true;
    else if (world.compactArmed !== false) reason ??= `auto-compacting at ~${tokens} tokens (threshold ${threshold})`;
  }
  if (reason === null) return;

  fx.toolStart("ManageContext", reason);
  let changed = false;
  try {
    const r = await runManageContext(world, fx, AUTO_PRUNE_INSTRUCTIONS, "auto", tokens ?? contextTokens(world));
    changed = r.changed;
    fx.toolDone("ManageContext", true, r.output);
  } catch (err) {
    fx.toolDone("ManageContext", false, `Context management failed: ${errorMessage(err)}`);
    if (mustPropagate(err, config)) throw err;
  }
  // Only re-arm the token trigger when compaction actually changed
  // something; otherwise wait until the context is back under the threshold.
  if (threshold > 0) world.compactArmed = changed;
}

/**
 * Emit `tool_start`, run `body`, emit the matching `tool_done`.  If `body`
 * throws (interrupt, fatal error) the tool still gets a failed `tool_done`
 * so UIs keyed on tool_start never show it running forever.
 */
async function withToolEvents(
  fx: Effects,
  call: ToolCall,
  preview: string,
  body: () => Promise<{ result: ToolResult; done?: string }>,
): Promise<ToolResult> {
  fx.toolStart(call.name, preview, call.args, call.id);
  try {
    const { result, done } = await body();
    fx.toolDone(call.name, result.success, done ?? (result.success ? "ok" : result.output));
    return result;
  } catch (err) {
    fx.toolDone(call.name, false, err instanceof AbortError ? "interrupted" : errorMessage(err));
    throw err;
  }
}

/** Execute one tool call and produce its result (never throws for ordinary tool failures). */
async function invokeOne(
  call: ToolCall,
  world: World,
  fx: Effects,
  config?: LoopConfig,
): Promise<ToolResult> {
  const ok = (output: string): ToolResult => ({ name: call.name, output, success: true, id: call.id });
  const fail = (output: string): ToolResult => ({ name: call.name, output, success: false, id: call.id });

  // Arguments that were not valid JSON are never executed — guessing could
  // e.g. run half a JSON object as a shell command.
  if (call.parseError !== undefined) {
    const output =
      `The arguments for ${call.name} were not valid JSON (${call.parseError}), so the tool was not run. ` +
      `Re-issue the call with complete, valid JSON arguments.`;
    return withToolEvents(fx, call, "(malformed arguments)", async () => ({ result: fail(output) }));
  }

  // A spawn-classified call (e.g. `Bash("gloop --task …")`) is a tool call
  // whose "execute" is another agent: run it through the spawn boundary
  // and record the result exactly like a tool result.
  const spawnTask = config?.classifySpawn?.(call) ?? null;
  if (spawnTask !== null) {
    return withToolEvents(fx, call, `spawn: ${spawnTask.substring(0, 50)}`, async () => {
      const r = await runSpawn(world, fx, spawnTask);
      const result = spawnToToolResult(r);
      return { result: { ...result, name: call.name, id: call.id }, done: r.success ? "ok" : result.output };
    });
  }

  // AskUser — through the `ask` interceptor chain, like the Ask form.
  if (call.name === "AskUser") {
    const question = call.args.question ?? "What would you like to do?";
    return withToolEvents(fx, call, question.substring(0, 60), async () => {
      const answer = await runAsk(world, fx, question);
      return { result: ok(`User answered: ${answer}`), done: "answered" };
    });
  }

  // ManageContext — run the context strategy.  A failing strategy is a
  // failed tool result, not a failed turn.
  if (call.name === "ManageContext") {
    const instructions = call.args.instructions ?? "Prune stale messages";
    return withToolEvents(fx, call, instructions.substring(0, 60), async () => {
      try {
        const { output } = await runManageContext(world, fx, instructions, "tool", contextTokens(world));
        return { result: ok(output), done: output };
      } catch (err) {
        if (mustPropagate(err, config)) throw err;
        return { result: fail(`Context management failed: ${errorMessage(err)}`) };
      }
    });
  }

  // Remember / Forget — through the `memory` interceptor chain.
  if (call.name === "Remember" || call.name === "Forget") {
    const op = call.name === "Remember" ? "remember" : "forget";
    const content = call.args.content ?? "";
    return withToolEvents(fx, call, content.substring(0, 60), async () => {
      try {
        await runMemory(world, fx, op, content);
      } catch (err) {
        if (mustPropagate(err, config)) throw err;
        return { result: fail(`Failed to ${op}: ${errorMessage(err)}`) };
      }
      return op === "remember"
        ? { result: ok(`Remembered: ${content}`), done: "remembered" }
        : { result: ok(`Forgot: ${content}`), done: "forgotten" };
    });
  }

  // Build a short preview from declared argument order (insertion order of
  // `call.args` matches the registry's declared argument list since the
  // parser iterates `tool.arguments`).
  const preview = Object.values(call.args)
    .map((v) => `"${v.substring(0, 40)}${v.length > 40 ? "..." : ""}"`)
    .join(", ");

  // Resolve the tool early so askPermission is available
  const tool = world.registry.get(call.name);
  if (!tool) {
    return withToolEvents(fx, call, preview, async () => ({ result: fail(`Unknown tool: ${call.name}`) }));
  }

  // Check if confirmation needed — first the legacy Bash check, then tool's own askPermission
  let danger = requiresConfirmation(call);
  if (danger === null && tool.askPermission) {
    danger = tool.askPermission(call.args);
  }
  if (danger !== null) {
    // Route through the same `confirm` interceptor chain as form-level
    // Confirm so policy interceptors apply to tool gating too.
    const approved = await chainBoundary(
      world.interceptors,
      "confirm",
      (ctx) => fx.confirm(ctx.command),
    )({ command: danger } as ConfirmContext);
    if (!approved) {
      return withToolEvents(fx, call, preview, async () => ({
        result: fail("User denied execution"),
        done: "denied by user",
      }));
    }
  }

  const cap = tool.maxOutputChars ?? config?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;

  return withToolEvents(fx, call, preview, () => withWorldSpan(
    world,
    `tool.${call.name}`,
    { tool: call.name, argCount: Object.keys(call.args).length },
    async (span) => {
      const ctx: ToolCallContext = { name: call.name, args: call.args };
      const result = await chainBoundary(
        world.interceptors,
        "toolCall",
        async (innerCtx): Promise<ToolCallResult> => {
          // Re-resolve the tool if an interceptor renamed it.
          const resolved =
            innerCtx.name === call.name ? tool : world.registry.get(innerCtx.name);
          if (!resolved) {
            return {
              success: false,
              output: `Unknown tool: ${innerCtx.name}`,
            };
          }
          // Fatal errors are never retried.
          const configured = resolved.retryable ? config?.retry?.tool : undefined;
          const policy = configured
            ? {
                ...configured,
                retryIf: (err: unknown, attempt: number) =>
                  !mustPropagate(err, config) && (configured.retryIf ?? defaultRetryIf)(err, attempt),
              }
            : undefined;
          try {
            // Race against the turn's signal so an interrupt unwinds
            // promptly even for a tool that ignores `ctx.signal`.
            const output = await raceAbort(
              world.signal,
              withRetry(
                policy,
                () => resolved.execute(innerCtx.args, { signal: world.signal }),
                {
                  signal: world.signal,
                  onRetry: (info) =>
                    fx.record?.({
                      type: "retry",
                      boundary: "tool",
                      name: innerCtx.name,
                      attempt: info.attempt,
                      maxAttempts: info.maxAttempts,
                      delayMs: info.delayMs,
                      error: toErrorInfo(info.error),
                    }),
                },
              ),
            );
            return { success: true, output };
          } catch (err) {
            // Interrupts and fatal errors (e.g. a Reboot signal) unwind the turn.
            if (mustPropagate(err, config)) throw err;
            const msg = err instanceof Error
              ? `${err.message}${err.stack ? "\n" + err.stack.split("\n").slice(1, 4).join("\n") : ""}`
              : String(err);
            return { success: false, output: msg, error: err };
          }
        },
      )(ctx);

      // One output policy for every tool — custom ones included.
      const output = truncateOutput(result.output, cap);
      span.setAttribute("ok", result.success);
      span.setAttribute("outputLength", result.output.length);
      if (!result.success && "error" in result && result.error !== undefined) {
        span.recordException(result.error);
      }
      return {
        result: { name: call.name, output, success: result.success, id: call.id },
        done: result.success ? "ok" : output,
      };
    },
  ));
}

/** Invoke: execute tools (with confirmation), then continue */
async function evalInvoke(
  calls: ToolCall[],
  then: Continuation,
  world: World,
  fx: Effects,
  config?: LoopConfig,
): Promise<void> {
  const results: ToolResult[] = [];

  // Check for Reload — will need to refresh system prompt after
  const hasReload = calls.some(c => c.name === "Reload");

  // Process each tool call
  try {
    for (const call of calls) {
      if (world.signal?.aborted) throw new AbortError();
      results.push(await invokeOne(call, world, fx, config));
    }
  } catch (err) {
    // The turn is unwinding mid-batch (interrupt, fatal error).  Still
    // record what already ran — plus a note for every call that didn't —
    // so history stays provider-valid and the model knows what happened.
    recordNativeToolMessages(
      world,
      fx,
      results,
      err instanceof AbortError
        ? "Interrupted by the user before this tool call completed."
        : `Not completed: the turn stopped with an error (${errorMessage(err)}).`,
    );
    throw err;
  }

  // Record the assistant's tool calls and their results natively in history
  // BEFORE any reload/prune so the model's next request sees a consistent
  // assistant-toolCalls → tool-responses pair.
  recordNativeToolMessages(world, fx, results);

  // Refresh system prompt if Reload was called
  if (hasReload) {
    await fx.refreshSystem();
  }

  // Automatic context compaction (tool-call interval / token threshold)
  await autoCompact(world, fx, config, calls.length);

  // Continue with the results
  const nextForm = then(results);
  return eval_(nextForm, world, fx, config);
}

// ============================================================================
// PARSE INPUT — The unified REPL reader (slash commands → Forms)
// ============================================================================

/** Parse raw user input into a Form: slash commands become special forms,
 *  everything else becomes Think. Like `read` in a Lisp REPL.
 *  Only a known command (`/skills`, `/skill`, `/install`, `/tools`) or a
 *  skill name is a command — "/etc/hosts looks wrong" goes to the model. */
export function parseInput(input: string, config?: LoopConfig): Form {
  const t = input.trim();
  if (!t.startsWith("/")) return Think(t);

  const firstSpace = t.search(/\s/);
  const cmd = firstSpace === -1 ? t : t.slice(0, firstSpace);
  const arg = firstSpace === -1 ? "" : t.slice(firstSpace + 1).trim();

  // Built-ins that must not be treated as skill names (e.g. a skill named "skills").
  if (cmd === "/skills") {
    return Emit(formatSkillsListing(config?.skills), Nil);
  }

  // `/skill <name> [args]` — same as `/<name> [args]` (helps discovery / avoids typos in long names).
  if (cmd === "/skill") {
    if (!arg.trim()) {
      return Emit(
        "Usage: /skill <name> [arguments]\nExample: /skill web-design-guidelines",
        Nil,
      );
    }
    const input = thinkInputFromSkillSubcommand(arg, config?.skills);
    if (input === null) {
      const sp = arg.search(/\s/);
      const skillName = (sp === -1 ? arg : arg.slice(0, sp)).trim();
      if (!config?.skills?.length) {
        return Emit("No skills are loaded.", Nil);
      }
      return Emit(`Unknown skill "${skillName}". Use /skills to list.`, Nil);
    }
    return Think(input);
  }

  // Skills take precedence over remaining built-ins (e.g. /install) when names collide.
  const skillMatch = matchSkillSlash(t, config?.skills);
  if (skillMatch) return Think(skillInvocationToThinkInput(skillMatch));

  switch (cmd) {
    case "/install": return arg ? Install(arg) : Emit("Usage: /install <url|path>", Nil);
    case "/tools":   return ListTools();
    // Not a command — a path, a regex, a fraction… — send it to the model.
    default:         return Think(t);
  }
}

// ============================================================================
// RUN — The top-level entry point
// ============================================================================

/**
 * run : string × World × Effects × LoopConfig? → Promise<void>
 *
 * Start the agent loop with user input.
 */
export async function run(
  input: string,
  world: World,
  fx: Effects,
  config?: LoopConfig,
): Promise<void> {
  world.llmCalls = 0;
  world.pendingToolCalls = null;
  return eval_(parseInput(input, config), world, fx, config);
}
