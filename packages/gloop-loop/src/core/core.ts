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
import type { JsonToolCall } from "../ai/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import { jsonToolCallsToToolCalls } from "../tools/parser.js";
import { requiresConfirmation } from "../tools/validator.js";
import type { Skill } from "../skills.js";
import {
  formatSkillsListing,
  matchSkillSlash,
  skillInvocationToThinkInput,
  thinkInputFromSkillSubcommand,
} from "../skills.js";
import type { Span, Tracer } from "../trace.js";
import { NoopTracer, withSpan } from "../trace.js";
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
}

export class AbortError extends Error {
  constructor() { super("Interrupted by user"); this.name = "AbortError"; }
}

/** Race a promise against an AbortSignal. Rejects with AbortError if signal fires. */
export function raceAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AbortError());
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new AbortError()), { once: true })
    ),
  ]);
}

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

export interface Effects {
  streamChunk: (text: string) => void;
  streamDone: () => void;
  toolStart: (name: string, preview: string) => void;
  toolDone: (name: string, ok: boolean, output: string) => void;
  confirm: (command: string) => Promise<boolean>;
  ask: (question: string) => Promise<string>;
  remember: (content: string) => Promise<void>;
  forget: (content: string) => Promise<void>;
  refreshSystem: () => Promise<void>;
  manageContext: (instructions: string) => Promise<string>;
  complete: (summary: string) => void;
  installTool: (source: string) => Promise<string>;
  listTools: () => string;
  spawn: (task: string) => Promise<SpawnResult>;
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

/** foldr over spawn tasks: chain Spawn forms right-to-left with a base continuation.
 *  Like (foldr (λ task acc → Spawn task (λ r → Emit r acc)) base tasks) */
function chainSpawns(tasks: string[], base: Form): Form {
  return tasks.reduceRight<Form>(
    (acc, task) => Spawn(task, (r) => Emit(formatResults([spawnToToolResult(r)]), acc)),
    base,
  );
}

/** Build a Form from a list of ToolCalls, using optional spawn classifier */
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

  // Mixed or all-spawn: invoke plain tools first (if any), then fold spawns, then think
  if (plainCalls.length > 0) {
    return Invoke(plainCalls, (toolResults) =>
      chainSpawns(spawnTasks, native ? Continue() : Think(formatResults(toolResults)))
    );
  }

  // All spawns: fold into a chain that collects results then thinks
  return chainSpawns(spawnTasks, Think(""));
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
      await withWorldSpan(
        world,
        "memory.remember",
        { contentLength: form.content.length },
        () =>
          chainBoundary(world.interceptors, "memory", (ctx) =>
            fx.remember(ctx.content),
          )({ op: "remember", content: form.content } as MemoryContext),
      );
      return eval_(form.then, world, fx, config);

    case "forget":
      await withWorldSpan(
        world,
        "memory.forget",
        { contentLength: form.content.length },
        () =>
          chainBoundary(world.interceptors, "memory", (ctx) =>
            fx.forget(ctx.content),
          )({ op: "forget", content: form.content } as MemoryContext),
      );
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
      const answer = await withWorldSpan(
        world,
        "request.ask",
        { question: form.question },
        async (span) => {
          const result = await chainBoundary(
            world.interceptors,
            "ask",
            (ctx) => fx.ask(ctx.question),
          )({ question: form.question } as AskContext);
          span.setAttribute("answerLength", result.length);
          return result;
        },
      );
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
      const result = await withWorldSpan(
        world,
        "spawn",
        { taskLength: form.task.length },
        async (span) => {
          const r = await chainBoundary(
            world.interceptors,
            "spawn",
            (ctx) => fx.spawn(ctx.task),
          )({ task: form.task } as SpawnContext);
          span.setAttribute("ok", r.success);
          span.setAttribute("exitCode", r.exitCode);
          return r;
        },
      );
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

      // The final handler runs the actual streaming call. Interceptors can
      // observe `ctx`, mutate `ctx.input`, short-circuit (return a synthetic
      // result), or wrap with retry / timing / caching logic.
      const result = await chainBoundary(
        world.interceptors,
        "llmCall",
        async (innerCtx): Promise<LlmCallResult> => {
          let fullText = "";
          const stream = input === null
            ? world.convo.streamContinue()
            : world.convo.stream(innerCtx.input);

          try {
            const iter = stream.textStream[Symbol.asyncIterator]();
            while (true) {
              const { done, value } = await raceIdleTimeout(
                raceAbort(world.signal, iter.next()),
                idleMs,
              );
              if (done) break;
              fx.streamChunk(value);
              fullText += value;
            }
          } catch (err) {
            if (err instanceof AbortError) {
              await stream.cancel().catch(() => {});
              if (fullText) {
                const h = world.convo.getHistory();
                h.push({ role: "assistant", content: fullText });
                world.convo.setHistory(h);
              }
            } else if (err instanceof LlmIdleTimeoutError) {
              await stream.cancel().catch(() => {});
            }
            throw err;
          }

          fx.streamDone();
          const calls = await raceIdleTimeout(stream.toolCalls, idleMs);
          const finishReason = await raceIdleTimeout(stream.finishReason, idleMs);
          return { text: fullText, toolCalls: calls, finishReason };
        },
      )(ctx);

      fx.log?.("LLM_OUTPUT", result.text);
      span.setAttribute("outputLength", result.text.length);
      span.setAttribute("toolCallsRequested", result.toolCalls.length);
      span.setAttribute("finishReason", result.finishReason ?? "unknown");
      return result;
    },
  );

  if (llmResult.toolCalls.length > 0) {
    const toolCalls = jsonToolCallsToToolCalls(
      [...llmResult.toolCalls],
      world.registry,
    );
    fx.log?.("TOOL_CALLS", JSON.stringify(toolCalls));
    // Stash the response so evalInvoke can record the assistant's tool calls
    // and their results natively in history.  Only when every call has a
    // provider id — otherwise there is nothing to correlate results against.
    if (llmResult.toolCalls.every((c) => c.id)) {
      world.pendingToolCalls = { text: llmResult.text, calls: [...llmResult.toolCalls] };
    }
    const nextForm = toolCallsToForm(toolCalls, config?.classifySpawn);
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
 * tasks) get a synthetic response so the provider never sees an unanswered
 * tool call id.
 */
function recordNativeToolMessages(world: World, results: ToolResult[]): void {
  const pending = world.pendingToolCalls;
  if (!pending) return;
  world.pendingToolCalls = null;

  const h = world.convo.getHistory();
  const last = h[h.length - 1];
  if (last && last.role === "assistant" && last.content === pending.text && !last.toolCalls) {
    h[h.length - 1] = { ...last, toolCalls: pending.calls };
  } else {
    h.push({ role: "assistant", content: pending.text, toolCalls: pending.calls });
  }

  const byId = new Map(results.filter((r) => r.id).map((r) => [r.id!, r]));
  for (const call of pending.calls) {
    const r = byId.get(call.id);
    h.push({
      role: "tool",
      toolCallId: call.id,
      content: r
        ? (r.success ? r.output : `Error: ${r.output}`)
        : "(handled by the host — no tool output)",
    });
  }
  world.convo.setHistory(h);
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
  for (const call of calls) {
    if (world.signal?.aborted) throw new AbortError();

    // Handle AskUser specially
    if (call.name === "AskUser") {
      const question = call.args.question ?? "What would you like to do?";
      fx.toolStart("AskUser", question.substring(0, 60));
      const answer = await fx.ask(question);
      results.push({ name: "AskUser", output: `User answered: ${answer}`, success: true, id: call.id });
      fx.toolDone("AskUser", true, "answered");
      continue;
    }

    // Handle ManageContext specially — fork a mini agent loop
    if (call.name === "ManageContext") {
      const instructions = call.args.instructions ?? "Prune stale messages";
      fx.toolStart("ManageContext", instructions.substring(0, 60));
      const result = await fx.manageContext(instructions);
      results.push({ name: "ManageContext", output: result, success: true, id: call.id });
      fx.toolDone("ManageContext", true, result);
      continue;
    }

    // Handle Remember specially — persist to memory + UI feedback
    if (call.name === "Remember") {
      const content = call.args.content ?? "";
      fx.toolStart("Remember", content.substring(0, 60));
      await fx.remember(content);
      results.push({ name: "Remember", output: `Remembered: ${content}`, success: true, id: call.id });
      fx.toolDone("Remember", true, "remembered");
      continue;
    }

    // Handle Forget specially — remove from memory + UI feedback
    if (call.name === "Forget") {
      const content = call.args.content ?? "";
      fx.toolStart("Forget", content.substring(0, 60));
      await fx.forget(content);
      results.push({ name: "Forget", output: `Forgot: ${content}`, success: true, id: call.id });
      fx.toolDone("Forget", true, "forgotten");
      continue;
    }

    // Resolve the tool early so askPermission is available
    const tool = world.registry.get(call.name);
    if (!tool) {
      results.push({ name: call.name, output: `Unknown tool: ${call.name}`, success: false, id: call.id });
      fx.toolDone(call.name, false, `Unknown tool: ${call.name}`);
      continue;
    }

    // Check if confirmation needed — first the legacy Bash check, then tool's own askPermission
    let danger = requiresConfirmation(call);
    if (danger === null && tool.askPermission) {
      danger = tool.askPermission(call.args);
    }
    if (danger !== null) {
      // Route through the same `confirm` interceptor chain as form-level
      // Confirm so policy interceptors apply to tool gating too.
      const ok = await chainBoundary(
        world.interceptors,
        "confirm",
        (ctx) => fx.confirm(ctx.command),
      )({ command: danger } as ConfirmContext);
      if (!ok) {
        results.push({ name: call.name, output: "User denied execution", success: false, id: call.id });
        fx.toolDone(call.name, false, "denied by user");
        continue;
      }
    }

    // Build a short preview from declared argument order (insertion order of
    // `call.args` matches the registry's declared argument list since the
    // parser iterates `tool.arguments`).
    const preview = Object.values(call.args)
      .map((v) => `"${v.substring(0, 40)}${v.length > 40 ? "..." : ""}"`)
      .join(", ");
    fx.toolStart(call.name, preview);

    await withWorldSpan(
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
            try {
              const output = await resolved.execute(innerCtx.args);
              return { success: true, output };
            } catch (err) {
              const msg = err instanceof Error
                ? `${err.message}${err.stack ? "\n" + err.stack.split("\n").slice(1, 4).join("\n") : ""}`
                : String(err);
              return { success: false, output: msg, error: err };
            }
          },
        )(ctx);

        results.push({
          name: call.name,
          output: result.output,
          success: result.success,
          id: call.id,
        });
        fx.toolDone(call.name, result.success, result.success ? "ok" : result.output);
        span.setAttribute("ok", result.success);
        span.setAttribute("outputLength", result.output.length);
        if (!result.success && "error" in result && result.error !== undefined) {
          span.recordException(result.error);
        }
      },
    );
  }

  // Record the assistant's tool calls and their results natively in history
  // BEFORE any reload/prune so the model's next request sees a consistent
  // assistant-toolCalls → tool-responses pair.
  recordNativeToolMessages(world, results);

  // Refresh system prompt if Reload was called
  if (hasReload) {
    await fx.refreshSystem();
  }

  // Auto-prune context every N tool calls (0 disables)
  const interval = config?.contextPruneInterval ?? 0;
  world.toolCalls += calls.length;
  if (interval > 0 && world.toolCalls >= interval) {
    world.toolCalls = 0;
    fx.toolStart("ManageContext", `auto-pruning after ${interval} tool calls`);
    const pruneResult = await fx.manageContext("Prune old tool results and intermediate outputs. Keep the current task goal, recent results, and any information the agent is actively using.");
    fx.toolDone("ManageContext", true, pruneResult);
  }

  // Continue with the results
  const nextForm = then(results);
  return eval_(nextForm, world, fx, config);
}

// ============================================================================
// PARSE INPUT — The unified REPL reader (slash commands → Forms)
// ============================================================================

/** Parse raw user input into a Form: slash commands become special forms,
 *  everything else becomes Think. Like `read` in a Lisp REPL. */
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
    default:         return Emit(`Unknown command: ${cmd}`, Nil);
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
