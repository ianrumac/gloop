/**
 * Effect-native adapters for gloop-loop's builtin tools.
 *
 * `toEffectTool` wraps any Promise-returning `ToolDefinition` into the
 * Effect-native `Tool` shape. `primitiveTools` applies the adapter to the
 * full portable builtin set (ReadFile, WriteFile, Patch_file, Bash,
 * CompleteTask, AskUser, Remember, Forget, ManageContext).
 *
 * `createNodeIO` is re-exported unchanged — it's a plain object with the
 * Promise API surface and works unmodified for adapted tools.
 */

import { Effect, Option } from "effect"
import {
  createNodeIO,
  primitiveTools as loopPrimitiveTools,
  type BuiltinIO,
  type ToolDefinition,
} from "@hypen-space/gloop-loop"
import type { Tool } from "../Tool.js"
import { ToolExecutionError } from "../Errors.js"

export { createNodeIO, type BuiltinIO }

export const toEffectTool = (
  def: ToolDefinition,
): Tool<ToolExecutionError> => ({
  name: def.name,
  description: def.description,
  arguments: def.arguments,
  askPermission: def.askPermission
    ? (args) => Option.fromNullable(def.askPermission!(args))
    : undefined,
  execute: (args) =>
    Effect.tryPromise({
      try: () => def.execute(args),
      catch: (e) =>
        new ToolExecutionError({
          name: def.name,
          message: e instanceof Error ? e.message : String(e),
          cause: e,
        }),
    }),
})

/**
 * Full set of portable built-ins, adapted to Effect tools. Pass a custom
 * `BuiltinIO` to override file/shell semantics (e.g. browser or sandboxed
 * environments).
 */
export const primitiveTools = (
  io?: BuiltinIO,
): ReadonlyArray<Tool<ToolExecutionError>> =>
  loopPrimitiveTools(io).map(toEffectTool)
