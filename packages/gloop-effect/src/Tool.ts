/**
 * gloop-effect/Tool — Tools and the runtime registry.
 *
 * A `Tool<E>` is an Effect-native description of a callable side-effect:
 * its `execute` returns an `Effect` instead of a `Promise`, so hosts can
 * plug in errors and interruption without wrapping. The error channel is
 * constrained to `AgentError` so failures fit the interpreter's union.
 *
 * `ToolCall`, `ToolResult`, and `ToolArgument` are shared with `gloop-loop`
 * as plain value types — the shapes match so the same builtins work on both
 * sides of the fence.
 */

import { Effect, Either, Option, Ref } from "effect"
import type {
  JsonTool,
  JsonToolCall,
  ToolArgument,
  ToolCall,
  ToolResult,
} from "@hypen-space/gloop-loop"
import type { AgentError } from "./Errors.js"

// ============================================================================
// Core types — re-exported from gloop-loop to share a single canonical shape
// ============================================================================

export type { ToolArgument, ToolCall, ToolResult }

/**
 * Tool — a named effectful operation.
 *
 * - `execute` returns an Effect whose error channel is a subtype of
 *   `AgentError`. Failures fold into `ToolResult { success: false }` at
 *   the interpreter boundary — the model can retry.
 * - `askPermission` returns `Some(reason)` to gate the call behind a
 *   confirmation prompt, or `None` to run immediately.
 *
 * `R = never` by default: tools with service dependencies should bake
 * them in via `Effect.provide` before registering.
 */
export interface Tool<E extends AgentError = AgentError, R = never> {
  readonly name: string
  readonly description: string
  readonly arguments: ReadonlyArray<ToolArgument>
  readonly askPermission?: (args: Record<string, string>) => Option.Option<string>
  readonly execute: (args: Record<string, string>) => Effect.Effect<string, E, R>
}

/**
 * Max-permissive form used internally by the registry — tools of any
 * error subtype can be stored together because the caller widens at the
 * `register` boundary.
 */
export type AnyTool = Tool<AgentError, never>

// ============================================================================
// JSON bridge
// ============================================================================

export const toJsonTool = (tool: AnyTool): JsonTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        tool.arguments.map((a) => [a.name, { type: "string", description: a.description }]),
      ),
      required: tool.arguments.map((a) => a.name),
    },
  },
})

/**
 * Safely parse a JSON string into a plain record. Malformed input yields
 * `None` — callers fall back to empty args.
 */
const parseJsonObject = (
  raw: string,
): Option.Option<Record<string, unknown>> => {
  const result = Either.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => "invalid json" as const,
  })
  if (Either.isLeft(result)) return Option.none()
  const value = result.right
  if (typeof value !== "object" || value === null) return Option.none()
  return Option.some(value as Record<string, unknown>)
}

/**
 * Convert provider-reported JSON tool calls into the `ToolCall` shape used
 * by the interpreter. Unknown tools collapse to an empty arg map so the
 * interpreter can emit a clean ToolNotFoundError downstream.
 */
export const jsonToolCallsToToolCalls = (
  calls: ReadonlyArray<JsonToolCall>,
  lookup: (name: string) => Option.Option<AnyTool>,
): ReadonlyArray<ToolCall> =>
  calls.map((call) => {
    const tool = lookup(call.function.name)
    const args: Record<string, string> = {}
    if (Option.isSome(tool)) {
      const parsed = parseJsonObject(call.function.arguments)
      if (Option.isSome(parsed)) {
        // Map declared argument names BY KEY — never positionally.
        for (const arg of tool.value.arguments) {
          const v = parsed.value[arg.name]
          if (v !== undefined && v !== null) args[arg.name] = String(v)
        }
      } else if (call.function.arguments && tool.value.arguments.length > 0) {
        // Arguments aren't a JSON object — bind the whole string to the
        // first declared argument (the "Bash with malformed json" fallback).
        args[tool.value.arguments[0]!.name] = call.function.arguments
      }
    }
    // Preserve the provider call id so results can be correlated back as
    // native tool messages.
    return { name: call.function.name, args, ...(call.id && { id: call.id }) }
  })

// ============================================================================
// Confirmation heuristics — shared with gloop-loop's Bash rm guard
// ============================================================================

const DANGEROUS_BASH_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+-rf?\b/,
  /\brm\s+-fr?\b/,
  /\brmdir\s/,
  />\s*\/dev\/sd[a-z]/,
  /\bmkfs\b/,
  /\bdd\s+.*of=/,
]

/** Returns the reason to confirm, or None if the call can run as-is. */
export const legacyBashConfirm = (call: ToolCall): Option.Option<string> => {
  if (call.name !== "Bash") return Option.none()
  const cmd = call.args.command ?? ""
  for (const pat of DANGEROUS_BASH_PATTERNS) {
    if (pat.test(cmd)) return Option.some(`Run potentially destructive command: ${cmd}`)
  }
  return Option.none()
}

// ============================================================================
// Registry
// ============================================================================

export interface ToolRegistry {
  readonly register: <E extends AgentError>(tool: Tool<E>) => Effect.Effect<void>
  readonly unregister: (name: string) => Effect.Effect<void>
  readonly get: (name: string) => Effect.Effect<Option.Option<AnyTool>>
  readonly has: (name: string) => Effect.Effect<boolean>
  readonly all: Effect.Effect<ReadonlyArray<AnyTool>>
  readonly names: Effect.Effect<ReadonlyArray<string>>
  readonly clear: Effect.Effect<void>
  readonly replace: (tools: ReadonlyArray<AnyTool>) => Effect.Effect<void>
  readonly toJsonTools: Effect.Effect<ReadonlyArray<JsonTool>>
  /** Snapshot the current lookup function for sync consumers (e.g. parsers). */
  readonly snapshotLookup: Effect.Effect<(name: string) => Option.Option<AnyTool>>
}

/**
 * Build a per-agent tool registry backed by a `Ref<Map>`. Each `Agent.make`
 * owns its own registry so tool mutations (`addTool` / `removeTool`) on one
 * agent don't leak into another.
 */
export const makeToolRegistry = (
  initial: ReadonlyArray<AnyTool> = [],
): Effect.Effect<ToolRegistry> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(
      new Map<string, AnyTool>(initial.map((t) => [t.name, t] as const)),
    )

    const register: ToolRegistry["register"] = Effect.fn("ToolRegistry.register")(
      function* <E extends AgentError>(tool: Tool<E>) {
        yield* Effect.annotateCurrentSpan("toolName", tool.name)
        yield* Ref.update(ref, (m) => {
          const next = new Map(m)
          // Widen at the storage boundary: every E extends AgentError.
          next.set(tool.name, tool as unknown as AnyTool)
          return next
        })
      },
    )

    const unregister = Effect.fn("ToolRegistry.unregister")(function* (name: string) {
      yield* Effect.annotateCurrentSpan("toolName", name)
      yield* Ref.update(ref, (m) => {
        if (!m.has(name)) return m
        const next = new Map(m)
        next.delete(name)
        return next
      })
    })

    const get = (name: string) =>
      Ref.get(ref).pipe(Effect.map((m) => Option.fromNullable(m.get(name))))

    const has = (name: string) => Ref.get(ref).pipe(Effect.map((m) => m.has(name)))

    const all = Ref.get(ref).pipe(Effect.map((m) => Array.from(m.values())))
    const names = Ref.get(ref).pipe(Effect.map((m) => Array.from(m.keys())))
    const clear = Ref.set(ref, new Map())

    const replace = (tools: ReadonlyArray<AnyTool>) =>
      Ref.set(ref, new Map(tools.map((t) => [t.name, t] as const)))

    const toJsonTools = Ref.get(ref).pipe(
      Effect.map((m) => Array.from(m.values()).map(toJsonTool)),
    )

    const snapshotLookup = Ref.get(ref).pipe(
      Effect.map((m) => (name: string) => Option.fromNullable(m.get(name))),
    )

    return {
      register,
      unregister,
      get,
      has,
      all,
      names,
      clear,
      replace,
      toJsonTools,
      snapshotLookup,
    }
  })
