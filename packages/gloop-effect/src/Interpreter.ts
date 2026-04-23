/**
 * gloop-effect/Interpreter — Effect-native Form evaluator.
 *
 * Reuses the pure `Form` ADT from `@hypen-space/gloop-loop` (Think, Invoke,
 * Confirm, Ask, Remember, Forget, Emit, Refresh, Done, Seq, Nil, Install,
 * ListTools, Spawn) and walks it recursively in an `Effect.gen` block.
 *
 * Differences from gloop-loop's async interpreter:
 *   - Control-flow aborts use fiber interruption, not a thrown AbortError.
 *   - Side-effects are routed through an `AgentHooks` service instead of a
 *     plain options bag.
 *   - Tool execution honors the Effect error channel, so tool errors can
 *     propagate as `ToolExecutionError` when the host wants — or be caught
 *     and folded into `ToolResult { success: false }` to continue the turn.
 */

import { Context, Effect, Either, Match, Option } from "effect"
import type { Form, SpawnResult } from "@hypen-space/gloop-loop"
import {
  parseInput as loopParseInput,
  toolCallsToForm,
  formatResults,
} from "@hypen-space/gloop-loop"
import type {
  JsonToolCall,
  LoopConfig as LoopConfigInternal,
  ToolCall,
  ToolResult,
} from "@hypen-space/gloop-loop"
import type { ConversationHandle } from "./Conversation.js"
import { AIProvider, consumeStream } from "./AIProvider.js"
import type { ToolRegistry } from "./Tool.js"
import { jsonToolCallsToToolCalls, legacyBashConfirm } from "./Tool.js"
import type { AgentError } from "./Errors.js"

// ============================================================================
// Hooks — the side-effect surface the interpreter depends on
// ============================================================================

export interface AgentHooks {
  readonly streamChunk: (text: string) => Effect.Effect<void>
  readonly streamDone: Effect.Effect<void>
  readonly toolStart: (name: string, preview: string) => Effect.Effect<void>
  readonly toolDone: (
    name: string,
    ok: boolean,
    output: string,
  ) => Effect.Effect<void>
  readonly confirm: (command: string) => Effect.Effect<boolean>
  readonly ask: (question: string) => Effect.Effect<string>
  readonly remember: (content: string) => Effect.Effect<void>
  readonly forget: (content: string) => Effect.Effect<void>
  readonly refreshSystem: Effect.Effect<void>
  readonly manageContext: (instructions: string) => Effect.Effect<string>
  readonly complete: (summary: string) => Effect.Effect<void>
  readonly installTool: (source: string) => Effect.Effect<string>
  readonly listTools: Effect.Effect<string>
  readonly spawn: (task: string) => Effect.Effect<SpawnResult>
  readonly log: (label: string, content: string) => Effect.Effect<void>
}

export class AgentHooksTag extends Context.Tag("gloop/AgentHooks")<
  AgentHooksTag,
  AgentHooks
>() {}

// ============================================================================
// World
// ============================================================================

export interface World {
  readonly convo: ConversationHandle
  readonly registry: ToolRegistry
  /** Running count of tool calls this turn — used for auto-prune cadence. */
  toolCalls: number
}

export const mkWorld = (
  convo: ConversationHandle,
  registry: ToolRegistry,
): World => ({ convo, registry, toolCalls: 0 })

// ============================================================================
// Loop config
// ============================================================================

export interface LoopConfig {
  readonly classifySpawn?: LoopConfigInternal["classifySpawn"]
  readonly contextPruneInterval?: number
  readonly skills?: LoopConfigInternal["skills"]
}

// ============================================================================
// Entry points
// ============================================================================

/** Parse raw user input into a Form (delegates to gloop-loop's pure parser). */
export const parseInput = (input: string, config?: LoopConfig): Form =>
  loopParseInput(input, config)

/** Run raw user input through parseInput + evalForm. */
export const run = (
  input: string,
  world: World,
  config?: LoopConfig,
): Effect.Effect<void, AgentError, AgentHooksTag | AIProvider> =>
  evalForm(parseInput(input, config), world, config)

// ============================================================================
// Interpreter
// ============================================================================

export const evalForm: (
  form: Form,
  world: World,
  config?: LoopConfig,
) => Effect.Effect<void, AgentError, AgentHooksTag | AIProvider> = Effect.fn(
  "Interpreter.evalForm",
)(function* (form: Form, world: World, config?: LoopConfig) {
  yield* Effect.annotateCurrentSpan("form", form.tag)
  const hooks = yield* AgentHooksTag

  const step = Match.type<Form>().pipe(
    Match.discriminators("tag")({
      nil: () => Effect.void,
      done: (f) => hooks.complete(f.summary),
      emit: (f) =>
        hooks
          .streamChunk(f.text)
          .pipe(
            Effect.zipRight(hooks.streamDone),
            Effect.zipRight(evalForm(f.then, world, config)),
          ),
      remember: (f) =>
        hooks.remember(f.content).pipe(
          Effect.zipRight(evalForm(f.then, world, config)),
        ),
      forget: (f) =>
        hooks.forget(f.content).pipe(
          Effect.zipRight(evalForm(f.then, world, config)),
        ),
      confirm: (f) =>
        Effect.flatMap(hooks.confirm(f.command), (ok) =>
          evalForm(f.then(ok), world, config),
        ),
      ask: (f) =>
        Effect.flatMap(hooks.ask(f.question), (answer) =>
          evalForm(f.then(answer), world, config),
        ),
      refresh: () => hooks.refreshSystem,
      seq: (f) =>
        Effect.forEach(f.forms, (child) => evalForm(child, world, config), {
          discard: true,
        }),
      think: (f) => evalThink(f.input, world, config),
      invoke: (f) => evalInvoke(f.calls, f.then, world, config),
      install: (f) =>
        Effect.flatMap(hooks.installTool(f.source), (result) =>
          hooks.streamChunk(result).pipe(Effect.zipRight(hooks.streamDone)),
        ),
      "list-tools": () =>
        Effect.flatMap(hooks.listTools, (text) =>
          hooks.streamChunk(text).pipe(Effect.zipRight(hooks.streamDone)),
        ),
      spawn: (f) =>
        Effect.flatMap(hooks.spawn(f.task), (result) =>
          evalForm(f.then(result), world, config),
        ),
    }),
    Match.exhaustive,
  )

  yield* step(form)
})

// ============================================================================
// Think — stream LLM response, follow up with any tool calls
// ============================================================================

const evalThink: (
  input: string,
  world: World,
  config: LoopConfig | undefined,
) => Effect.Effect<void, AgentError, AgentHooksTag | AIProvider> = Effect.fn(
  "Interpreter.evalThink",
)(function* (input: string, world: World, config: LoopConfig | undefined) {
  const hooks = yield* AgentHooksTag
  yield* hooks.log("LLM_INPUT", input)

  // Refresh tools on the conversation right before the request.
  const jsonTools = yield* world.registry.toJsonTools
  yield* world.convo.setJsonTools(jsonTools)

  const stream = yield* world.convo.stream(input)

  let fullText = ""
  const response = yield* consumeStream(stream, (chunk) =>
    Effect.sync(() => {
      fullText += chunk
    }).pipe(Effect.zipRight(hooks.streamChunk(chunk))),
  )

  yield* hooks.streamDone
  yield* hooks.log("LLM_OUTPUT", fullText)

  const jsonCalls: ReadonlyArray<JsonToolCall> = response.toolCalls ?? []
  if (jsonCalls.length === 0) return

  const lookup = yield* world.registry.snapshotLookup
  const toolCalls = jsonToolCallsToToolCalls(jsonCalls, lookup)

  yield* hooks.log("TOOL_CALLS", JSON.stringify(toolCalls))
  const nextForm = toolCallsToForm([...toolCalls], config?.classifySpawn)
  yield* evalForm(nextForm, world, config)
})

// ============================================================================
// Invoke — execute tools (with confirmation), then continue via continuation
// ============================================================================

const evalInvoke: (
  calls: ReadonlyArray<ToolCall>,
  then: (results: ToolResult[]) => Form,
  world: World,
  config: LoopConfig | undefined,
) => Effect.Effect<void, AgentError, AgentHooksTag | AIProvider> = Effect.fn(
  "Interpreter.evalInvoke",
)(function* (
  calls: ReadonlyArray<ToolCall>,
  then: (results: ToolResult[]) => Form,
  world: World,
  config: LoopConfig | undefined,
) {
  yield* Effect.annotateCurrentSpan("toolCount", calls.length)
  const hooks = yield* AgentHooksTag
  const hasReload = calls.some((c) => c.name === "Reload")

  const results = yield* Effect.forEach(calls, (call) =>
    dispatchCall(call, world, hooks),
  )

  if (hasReload) yield* hooks.refreshSystem

  // Auto-prune cadence — mirrors gloop-loop's behavior.
  const interval = config?.contextPruneInterval ?? 0
  world.toolCalls += calls.length
  if (interval > 0 && world.toolCalls >= interval) {
    world.toolCalls = 0
    yield* hooks.toolStart(
      "ManageContext",
      `auto-pruning after ${interval} tool calls`,
    )
    const pruneResult = yield* hooks.manageContext(
      "Prune old tool results and intermediate outputs. Keep the current task goal, recent results, and any information the agent is actively using.",
    )
    yield* hooks.toolDone("ManageContext", true, pruneResult)
  }

  yield* evalForm(then(results), world, config)
})

// ============================================================================
// Dispatch a single tool call → ToolResult (never fails the surrounding turn)
// ============================================================================

const BUILTIN_TOOLS = new Set(["AskUser", "ManageContext", "Remember", "Forget"])

const dispatchCall: (
  call: ToolCall,
  world: World,
  hooks: AgentHooks,
) => Effect.Effect<ToolResult, AgentError, AIProvider> = Effect.fn(
  "Interpreter.dispatchCall",
)(function* (call: ToolCall, world: World, hooks: AgentHooks) {
  yield* Effect.annotateCurrentSpan("tool", call.name)
  yield* Effect.annotateCurrentSpan(
    "kind",
    BUILTIN_TOOLS.has(call.name) ? "builtin" : "registry",
  )

  // Special forms handled inline — they don't live in the registry.
  const builtin = Match.value(call.name).pipe(
    Match.when("AskUser", () =>
      dispatchBuiltin(call, hooks, {
        previewFrom: (c) => c.args.question ?? "What would you like to do?",
        run: (c) =>
          hooks.ask(c.args.question ?? "What would you like to do?").pipe(
            Effect.map((answer): ToolResult => ({
              name: "AskUser",
              output: `User answered: ${answer}`,
              success: true,
            })),
          ),
        doneOutput: "answered",
      }),
    ),
    Match.when("ManageContext", () =>
      dispatchBuiltin(call, hooks, {
        previewFrom: (c) => c.args.instructions ?? "Prune stale messages",
        run: (c) =>
          hooks
            .manageContext(c.args.instructions ?? "Prune stale messages")
            .pipe(
              Effect.map((out): ToolResult => ({
                name: "ManageContext",
                output: out,
                success: true,
              })),
            ),
        doneOutputFrom: (r) => r.output,
      }),
    ),
    Match.when("Remember", () =>
      dispatchBuiltin(call, hooks, {
        previewFrom: (c) => c.args.content ?? "",
        run: (c) => {
          const content = c.args.content ?? ""
          return hooks.remember(content).pipe(
            Effect.as<ToolResult>({
              name: "Remember",
              output: `Remembered: ${content}`,
              success: true,
            }),
          )
        },
        doneOutput: "remembered",
      }),
    ),
    Match.when("Forget", () =>
      dispatchBuiltin(call, hooks, {
        previewFrom: (c) => c.args.content ?? "",
        run: (c) => {
          const content = c.args.content ?? ""
          return hooks.forget(content).pipe(
            Effect.as<ToolResult>({
              name: "Forget",
              output: `Forgot: ${content}`,
              success: true,
            }),
          )
        },
        doneOutput: "forgotten",
      }),
    ),
    Match.option,
  )

  if (Option.isSome(builtin)) {
    const result = yield* builtin.value
    yield* Effect.annotateCurrentSpan("success", result.success)
    return result
  }

  // Registry lookup
  const maybeTool = yield* world.registry.get(call.name)
  if (Option.isNone(maybeTool)) {
    yield* hooks.toolDone(call.name, false, `Unknown tool: ${call.name}`)
    yield* Effect.annotateCurrentSpan("success", false)
    return {
      name: call.name,
      output: `Unknown tool: ${call.name}`,
      success: false,
    }
  }
  const tool = maybeTool.value

  // Permission gating — heuristic first, then tool's own askPermission.
  const reason = Option.orElse(legacyBashConfirm(call), () =>
    tool.askPermission ? tool.askPermission(call.args) : Option.none(),
  )
  if (Option.isSome(reason)) {
    const ok = yield* hooks.confirm(reason.value)
    if (!ok) {
      yield* hooks.toolDone(call.name, false, "denied by user")
      yield* Effect.annotateCurrentSpan("success", false)
      yield* Effect.annotateCurrentSpan("denied", true)
      return {
        name: call.name,
        output: "User denied execution",
        success: false,
      }
    }
  }

  // Preview = ordered arg values, truncated.
  const preview = Object.values(call.args)
    .map((v) => `"${v.substring(0, 40)}${v.length > 40 ? "..." : ""}"`)
    .join(", ")
  yield* hooks.toolStart(call.name, preview)

  // Convert any tool error into a ToolResult(success: false). Tool errors
  // are *not* turn-fatal — the model can recover.
  const outcome = yield* Effect.either(tool.execute(call.args))

  if (Either.isRight(outcome)) {
    yield* hooks.toolDone(call.name, true, "ok")
    yield* Effect.annotateCurrentSpan("success", true)
    return { name: call.name, output: outcome.right, success: true }
  }
  const msg = renderToolError(outcome.left)
  yield* hooks.toolDone(call.name, false, msg)
  yield* Effect.annotateCurrentSpan("success", false)
  return { name: call.name, output: msg, success: false }
})

// ----------------------------------------------------------------------------
// Built-in tool dispatch helper — keeps the toolStart / toolDone pairing
// consistent across the 4 inline builtins (AskUser, ManageContext,
// Remember, Forget).
// ----------------------------------------------------------------------------

interface BuiltinDispatch {
  readonly previewFrom: (call: ToolCall) => string
  readonly run: (call: ToolCall) => Effect.Effect<ToolResult, AgentError>
  readonly doneOutput?: string
  readonly doneOutputFrom?: (result: ToolResult) => string
}

const dispatchBuiltin = (
  call: ToolCall,
  hooks: AgentHooks,
  dispatch: BuiltinDispatch,
): Effect.Effect<ToolResult, AgentError> =>
  Effect.gen(function* () {
    const preview = dispatch.previewFrom(call).substring(0, 60)
    yield* hooks.toolStart(call.name, preview)
    const result = yield* dispatch.run(call)
    const doneText =
      dispatch.doneOutputFrom?.(result) ?? dispatch.doneOutput ?? "ok"
    yield* hooks.toolDone(call.name, result.success, doneText)
    return result
  })

// ----------------------------------------------------------------------------
// Render an AgentError into a string for the model.
// ----------------------------------------------------------------------------

const renderToolError = (err: AgentError): string =>
  Match.value(err).pipe(
    Match.tag("ToolExecutionError", (e) => e.message),
    Match.tag(
      "ToolNotFoundError",
      "ToolPermissionDeniedError",
      "AIProviderError",
      "AgentInterruptedError",
      "FatalAgentError",
      "FileIOError",
      "ShellExecError",
      "MemoryError",
      (e) => e.message,
    ),
    Match.exhaustive,
  )

// Re-export for consumers composing Forms.
export { formatResults, toolCallsToForm }
