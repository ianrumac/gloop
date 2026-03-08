/**
 * gloop-loop core — A recursive Lisp-style agent loop
 *
 * The fundamental insight: an agent is just a recursive function that
 * transforms (World, Input) -> (World', Action) until Action = Done.
 *
 * Each "form" is a pure description of what to do next.
 * The interpreter evaluates forms, producing new forms, until termination.
 */

import type { AIConversation } from "../ai/builder.ts";
import type { JsonToolCall } from "../ai/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolCall, ToolResult } from "../tools/types.ts";
import { jsonToolCallsToToolCalls } from "../tools/parser.ts";
import { requiresConfirmation } from "../tools/validator.ts";

// ============================================================================
// FORMS — The S-expressions of our agent loop
// ============================================================================

/** A Form is a description of what to do next — pure data, no side effects */
export type Form =
  | { tag: "think"; input: string }                          // Send input to LLM, get response
  | { tag: "invoke"; calls: ToolCall[]; then: Continuation } // Execute tools, continue with results
  | { tag: "confirm"; command: string; then: (ok: boolean) => Form }
  | { tag: "ask"; question: string; then: (answer: string) => Form }
  | { tag: "remember"; content: string; then: Form }
  | { tag: "forget"; content: string; then: Form }
  | { tag: "emit"; text: string; then: Form }                // Output text to user
  | { tag: "refresh" }                                       // Refresh system prompt, re-think
  | { tag: "reboot"; reason: string }                        // Save state and restart process
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

export const Reboot = (reason: string): Form =>
  ({ tag: "reboot", reason });

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
  signal?: AbortSignal;
}

export class AbortError extends Error {
  constructor() { super("Interrupted by user"); this.name = "AbortError"; }
}

export const mkWorld = (
  convo: AIConversation,
  registry: ToolRegistry,
  signal?: AbortSignal,
): World => ({
  convo,
  registry,
  toolCalls: 0,
  signal,
});

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
  reboot: (reason: string, convo: AIConversation) => Promise<never>;
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

  /** Number of tool calls between automatic context prune. Default: 50 */
  contextPruneInterval?: number;
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
  const rebootCall = toolCalls.find(c => c.name === "Reboot");
  const regularCalls = toolCalls.filter(
    c => c.name !== "CompleteTask" && c.name !== "Reboot"
  );

  // Terminal forms: reboot / complete (optionally preceded by tool invocations)
  if (rebootCall) {
    const reason = rebootCall.rawArgs[0] ?? "Reboot requested";
    return regularCalls.length > 0 ? Invoke(regularCalls, () => Reboot(reason)) : Reboot(reason);
  }
  if (completeCall) {
    const summary = completeCall.rawArgs[0] ?? "Task complete";
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

  // No spawns: invoke tools, think with results
  if (spawnTasks.length === 0) {
    return Invoke(regularCalls, (results) => Think(formatResults(results)));
  }

  // Mixed or all-spawn: invoke plain tools first (if any), then fold spawns, then think
  if (plainCalls.length > 0) {
    return Invoke(plainCalls, (toolResults) =>
      chainSpawns(spawnTasks, Think(formatResults(toolResults)))
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
      await fx.remember(form.content);
      return eval_(form.then, world, fx, config);

    case "forget":
      await fx.forget(form.content);
      return eval_(form.then, world, fx, config);

    case "confirm": {
      const ok = await fx.confirm(form.command);
      const next = form.then(ok);
      return eval_(next, world, fx, config);
    }

    case "ask": {
      const answer = await fx.ask(form.question);
      const next = form.then(answer);
      return eval_(next, world, fx, config);
    }

    case "refresh":
      await fx.refreshSystem();
      return;

    case "reboot":
      await fx.reboot(form.reason, world.convo);
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
      const result = await fx.spawn(form.task);
      return eval_(form.then(result), world, fx, config);
    }
  }
}

/**
 * Think: stream LLM response via callModel's text/tool streams, then recurse.
 */
async function evalThink(
  input: string,
  world: World,
  fx: Effects,
  config?: LoopConfig,
): Promise<void> {
  let fullText = "";
  fx.log?.("LLM_INPUT", input);

  // Set tools on the conversation for this request
  const jsonTools = world.registry.toJsonTools();
  world.convo.setJsonTools(jsonTools);

  const result = world.convo.stream(input);

  // Build an abort promise that rejects when signal fires
  const abortPromise = world.signal
    ? new Promise<never>((_, reject) => {
        if (world.signal!.aborted) { reject(new AbortError()); return; }
        world.signal!.addEventListener("abort", () => reject(new AbortError()), { once: true });
      })
    : null;

  try {
    const iter = result.textStream[Symbol.asyncIterator]();
    while (true) {
      const next = iter.next();
      const { done, value } = abortPromise
        ? await Promise.race([next, abortPromise])
        : await next;
      if (done) break;

      fx.streamChunk(value);
      fullText += value;
    }
  } catch (err) {
    if (err instanceof AbortError) {
      await result.cancel().catch(() => {});
      if (fullText) {
        const h = world.convo.getHistory();
        h.push({ role: "assistant", content: fullText });
        world.convo.setHistory(h);
      }
      throw err;
    }
    throw err;
  }

  fx.streamDone();
  fx.log?.("LLM_OUTPUT", fullText);

  const jsonCalls = await result.toolCalls;

  if (jsonCalls.length > 0) {
    const toolCalls = jsonToolCallsToToolCalls(jsonCalls);
    fx.log?.("TOOL_CALLS", JSON.stringify(toolCalls));
    const nextForm = toolCallsToForm(toolCalls, config?.classifySpawn);
    return eval_(nextForm, world, fx, config);
  }

  return;
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
      const question = call.rawArgs[0] ?? "What would you like to do?";
      fx.toolStart("AskUser", question.substring(0, 60));
      const answer = await fx.ask(question);
      results.push({ name: "AskUser", output: `User answered: ${answer}`, success: true });
      fx.toolDone("AskUser", true, "answered");
      continue;
    }

    // Handle ManageContext specially — fork a mini agent loop
    if (call.name === "ManageContext") {
      const instructions = call.rawArgs[0] ?? "Prune stale messages";
      fx.toolStart("ManageContext", instructions.substring(0, 60));
      const result = await fx.manageContext(instructions);
      results.push({ name: "ManageContext", output: result, success: true });
      fx.toolDone("ManageContext", true, result);
      continue;
    }

    // Handle Remember specially — persist to memory + UI feedback
    if (call.name === "Remember") {
      const content = call.rawArgs[0] ?? "";
      fx.toolStart("Remember", content.substring(0, 60));
      await fx.remember(content);
      results.push({ name: "Remember", output: `Remembered: ${content}`, success: true });
      fx.toolDone("Remember", true, "remembered");
      continue;
    }

    // Handle Forget specially — remove from memory + UI feedback
    if (call.name === "Forget") {
      const content = call.rawArgs[0] ?? "";
      fx.toolStart("Forget", content.substring(0, 60));
      await fx.forget(content);
      results.push({ name: "Forget", output: `Forgot: ${content}`, success: true });
      fx.toolDone("Forget", true, "forgotten");
      continue;
    }

    // Resolve the tool early so askPermission is available
    const tool = world.registry.get(call.name);
    if (!tool) {
      results.push({ name: call.name, output: `Unknown tool: ${call.name}`, success: false });
      fx.toolDone(call.name, false, `Unknown tool: ${call.name}`);
      continue;
    }

    // Check if confirmation needed — first the legacy Bash check, then tool's own askPermission
    let danger = requiresConfirmation(call);
    if (danger === null && tool.askPermission) {
      const args: Record<string, string> = {};
      tool.arguments.forEach((arg, i) => {
        if (i < call.rawArgs.length) args[arg.name] = call.rawArgs[i]!;
      });
      danger = tool.askPermission(args);
    }
    if (danger !== null) {
      const ok = await fx.confirm(danger);
      if (!ok) {
        results.push({ name: call.name, output: "User denied execution", success: false });
        fx.toolDone(call.name, false, "denied by user");
        continue;
      }
    }

    const preview = call.rawArgs
      .map(a => `"${a.substring(0, 40)}${a.length > 40 ? "..." : ""}"`)
      .join(", ");
    fx.toolStart(call.name, preview);

    try {
      const args: Record<string, string> = {};
      tool.arguments.forEach((arg, i) => {
        if (i < call.rawArgs.length) args[arg.name] = call.rawArgs[i]!;
      });
      const output = await tool.execute(args);
      results.push({ name: call.name, output, success: true });
      fx.toolDone(call.name, true, "ok");
    } catch (err: unknown) {
      const msg = err instanceof Error
        ? `${err.message}${err.stack ? "\n" + err.stack.split("\n").slice(1, 4).join("\n") : ""}`
        : String(err);
      results.push({ name: call.name, output: msg, success: false });
      fx.toolDone(call.name, false, msg);
    }
  }

  // Refresh system prompt if Reload was called
  if (hasReload) {
    await fx.refreshSystem();
  }

  // Auto-prune context every N tool calls
  const interval = config?.contextPruneInterval ?? 50;
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
export function parseInput(input: string): Form {
  const t = input.trim();
  if (!t.startsWith("/")) return Think(t);

  const [cmd, ...rest] = t.split(" ");
  const arg = rest.join(" ").trim();

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
  return eval_(parseInput(input), world, fx, config);
}
