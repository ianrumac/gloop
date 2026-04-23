/**
 * Effect-native wrapper around gloop-loop's `createFileMemory`.
 *
 * Surfaces three Effects (`remember`, `forget`, `read`) that hosts can plug
 * into `AgentMakeOptions` directly — no extra layer required.
 */

import { Effect } from "effect"
import {
  createFileMemory,
  type FileMemoryOptions,
} from "@hypen-space/gloop-loop"
import { MemoryError } from "../Errors.js"

export interface FileMemoryHandle {
  readonly remember: (content: string) => Effect.Effect<void, MemoryError>
  readonly forget: (content: string) => Effect.Effect<void, MemoryError>
  readonly read: Effect.Effect<string, MemoryError>
}

const toMemoryError =
  (op: "remember" | "forget" | "read") =>
  (e: unknown): MemoryError =>
    new MemoryError({
      op,
      message: e instanceof Error ? e.message : String(e),
      cause: e,
    })

export const fileMemory = (
  options?: FileMemoryOptions,
): FileMemoryHandle => {
  const underlying = createFileMemory(options)
  return {
    remember: (content) =>
      Effect.tryPromise({
        try: () => underlying.remember(content),
        catch: toMemoryError("remember"),
      }),
    forget: (content) =>
      Effect.tryPromise({
        try: () => underlying.forget(content),
        catch: toMemoryError("forget"),
      }),
    read: Effect.tryPromise({
      try: () => underlying.read(),
      catch: toMemoryError("read"),
    }),
  }
}
