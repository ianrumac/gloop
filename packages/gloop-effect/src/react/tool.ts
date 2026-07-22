/**
 * gloop-effect/react/tool — the Tool monad.
 *
 * A tool is, at heart, a Kleisli arrow: `args -> Effect<Output>`. `tool(name)`
 * builds one fluently and gives you the operations you'd expect on that arrow:
 *
 *   - `handle` — set the body (the "unit"; accepts Effect | Promise | value)
 *   - `map`    — transform the output          (functor)
 *   - `flatMap`— chain another effectful step  (monad bind)
 *   - `tap`    — run a side effect, keep output
 *   - `confirmWhen` — gate the call behind a confirmation prompt
 *
 * The builder is immutable — every combinator returns a fresh builder — and
 * coerces to a plain `Tool<ToolExecutionError>` via `toTool()`, so it drops
 * straight into `useTool` or `Agent.make({ tools })`.
 */

import { Effect, Option } from "effect"
import type { ToolArgument } from "@hypen-space/gloop-loop"
import { ToolExecutionError } from "../Errors.js"
import type { Tool } from "../Tool.js"

type Args = Record<string, string>

/** What a handler may return — coerced into an Effect<string>. */
export type Handled =
  | string
  | Effect.Effect<string, ToolExecutionError>
  | Promise<string>

export type Handler = (args: Args) => Handled

const isEffect = (x: unknown): x is Effect.Effect<string, ToolExecutionError> =>
  typeof x === "object" && x !== null && Effect.isEffect(x as never)

const isPromise = (x: unknown): x is Promise<string> =>
  typeof x === "object" && x !== null && typeof (x as { then?: unknown }).then === "function"

/** Coerce a handler's return into the Effect the interpreter expects. */
const coerce = (
  name: string,
  out: Handled,
): Effect.Effect<string, ToolExecutionError> => {
  if (isEffect(out)) return out
  if (isPromise(out)) {
    return Effect.tryPromise({
      try: () => out,
      catch: (e) =>
        new ToolExecutionError({
          name,
          message: e instanceof Error ? e.message : String(e),
          cause: e,
        }),
    })
  }
  return Effect.succeed(out)
}

interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly arguments: ReadonlyArray<ToolArgument>
  readonly askPermission?: (args: Args) => Option.Option<string>
  readonly run: (args: Args) => Effect.Effect<string, ToolExecutionError>
}

export interface ToolBuilder extends Tool<ToolExecutionError> {
  /** One-line description shown to the model. */
  readonly describe: (description: string) => ToolBuilder
  /** Declare a named string argument. */
  readonly arg: (name: string, description: string) => ToolBuilder
  /** Set the body. Accepts an Effect, a Promise, or a plain string. */
  readonly handle: (fn: Handler) => ToolBuilder
  /** Transform the output string. */
  readonly map: (f: (output: string) => string) => ToolBuilder
  /** Chain another effectful step on the output. */
  readonly flatMap: (
    f: (output: string) => Effect.Effect<string, ToolExecutionError>,
  ) => ToolBuilder
  /** Run a side effect on the output, passing it through unchanged. */
  readonly tap: (
    f: (output: string) => Effect.Effect<unknown, ToolExecutionError>,
  ) => ToolBuilder
  /** Gate the call behind a confirmation prompt when the predicate matches. */
  readonly confirmWhen: (
    f: (args: Args) => string | boolean,
  ) => ToolBuilder
}

const notImplemented = (name: string) => (): Effect.Effect<string, ToolExecutionError> =>
  Effect.fail(
    new ToolExecutionError({
      name,
      message: `Tool "${name}" has no handler — call .handle(...)`,
    }),
  )

const build = (spec: ToolSpec): ToolBuilder => {
  const self: ToolBuilder = {
    // --- Tool<ToolExecutionError> surface (structural) ---
    name: spec.name,
    description: spec.description,
    arguments: spec.arguments,
    askPermission: spec.askPermission,
    execute: spec.run,

    // --- combinators ---
    describe: (description) => build({ ...spec, description }),
    arg: (name, description) =>
      build({ ...spec, arguments: [...spec.arguments, { name, description }] }),
    handle: (fn) =>
      build({ ...spec, run: (args) => coerce(spec.name, fn(args)) }),
    map: (f) => build({ ...spec, run: (args) => Effect.map(spec.run(args), f) }),
    flatMap: (f) =>
      build({ ...spec, run: (args) => Effect.flatMap(spec.run(args), f) }),
    tap: (f) => build({ ...spec, run: (args) => Effect.tap(spec.run(args), f) }),
    confirmWhen: (f) =>
      build({
        ...spec,
        askPermission: (args) => {
          const r = f(args)
          if (r === false) return Option.none()
          if (r === true) return Option.some(`Run ${spec.name}?`)
          return Option.some(r)
        },
      }),
  }
  return self
}

/** Start a new tool. `tool("Search").describe(...).arg(...).handle(...)`. */
export const tool = (name: string): ToolBuilder =>
  build({
    name,
    description: "",
    arguments: [],
    run: notImplemented(name),
  })
