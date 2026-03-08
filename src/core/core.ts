/**
 * gloop core — Re-exports the core loop from @anthropic/gloop-loop
 * and provides gloop-specific wiring (debug logging, spawn classification).
 */

import { debugLogRaw } from "./debug.ts";
import { parseGloopTaskBashCommand } from "./task-mode.ts";

// Re-export everything from the library
export {
  // Form constructors
  Think,
  Invoke,
  Confirm,
  Ask,
  Remember,
  Forget,
  Emit,
  Refresh,
  Reboot,
  Done,
  Seq,
  Nil,
  Install,
  ListTools,
  Spawn,
  // World
  AbortError,
  mkWorld,
  // Interpreter
  eval_,
  toolCallsToForm,
  formatResults,
  parseInput,
} from "@anthropic/gloop-loop";

export type {
  Form,
  SpawnResult,
  Continuation,
  World,
  Effects,
  LoopConfig,
} from "@anthropic/gloop-loop";

import {
  run as libRun,
  type World,
  type Effects,
  type LoopConfig,
  type ToolCall,
} from "@anthropic/gloop-loop";

/** Gloop-specific spawn classifier: detects `gloop --task "..."` in Bash calls */
function gloopClassifySpawn(call: ToolCall): string | null {
  if (call.name !== "Bash") return null;
  const req = parseGloopTaskBashCommand(call.rawArgs[0] ?? "");
  return req ? req.task : null;
}

/**
 * run — Gloop-specific entry point that wires in:
 * - Debug logging via fx.log
 * - Spawn classification for `gloop --task` commands
 */
export async function run(
  input: string,
  world: World,
  fx: Effects,
  config?: LoopConfig,
): Promise<void> {
  // Wire debug logging into Effects if not already set
  const wiredFx: Effects = {
    ...fx,
    log: fx.log ?? ((label, content) => debugLogRaw(label, content)),
  };

  // Wire gloop-specific spawn classifier
  const wiredConfig: LoopConfig = {
    classifySpawn: gloopClassifySpawn,
    ...config, // User config overrides
  };

  return libRun(input, world, wiredFx, wiredConfig);
}
