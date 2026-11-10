/**
 * Argument parsing for the interactive CLI (bin/index.ts), kept separate so
 * it can be unit-tested without launching the agent.
 */

import type { EventRef } from "@hypen-space/gloop-loop";
import { DEFAULT_GLOOP_MODEL } from "./default-model.ts";
import { appendTaskPromptSuffix, decodeCause } from "./task-mode.ts";
import { matchSettingFlag, type SettingFlags } from "./config.ts";

export interface GloopCliArgs {
  clone: boolean;
  debug: boolean;
  /** `--provider <name>` — OpenRouter provider routing. */
  providerName?: string;
  /**
   * `--resume [path]`: `requested` is true when the flag is present;
   * `path` is the explicit log path if one followed the flag.
   */
  resume: { requested: boolean; path?: string };
  /** First bare positional that is not a flag value, else the default model. */
  model: string;
  /** Safety-setting flags (`--max-iterations` …), raw — see config.ts. */
  settings: SettingFlags;
}

const takesValue = new Set(["--provider", "--resume"]);

export function parseGloopArgs(args: string[]): GloopCliArgs {
  const out: GloopCliArgs = {
    clone: false,
    debug: false,
    resume: { requested: false },
    model: DEFAULT_GLOOP_MODEL,
    settings: {},
  };
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    const setting = matchSettingFlag(a, next);
    if (setting) { out.settings[setting.key] = setting.value; if (setting.consumedNext) i++; }
    else if (a === "--clone") out.clone = true;
    else if (a === "--debug") out.debug = true;
    else if (a === "--provider") { if (hasValue) out.providerName = args[++i]; }
    else if (a === "--resume") { out.resume.requested = true; if (hasValue) out.resume.path = args[++i]; }
    else if (a.startsWith("--")) { if (takesValue.has(a) && hasValue) i++; }
    else if (model === undefined) model = a;
  }

  if (model !== undefined) out.model = model;
  return out;
}


// ---------------------------------------------------------------------------
// Headless (src/core/headless.ts)
// ---------------------------------------------------------------------------

export interface HeadlessArgs {
  model: string;
  outputPath: string;
  debug: boolean;
  providerName?: string;
  clone: boolean;
  /** The instruction to run (with the task suffix applied for `--task`). */
  instruction: string;
  /** `--session <path>`: append to exactly this log (spawned subagents). */
  session?: string;
  /** `--agent-id <id>`: id stamped on this run's events. */
  agentId: string;
  /** `--cause <agent>@<eventId>@<log>`: the parent event that spawned this run. */
  cause?: EventRef;
  /** Safety-setting flags (`--max-iterations` …), raw — see config.ts. */
  settings: SettingFlags;
}

export function parseHeadlessArgs(args: string[]): HeadlessArgs {
  const out: HeadlessArgs = {
    model: DEFAULT_GLOOP_MODEL,
    outputPath: "gloop-output.jsonl",
    debug: false,
    clone: false,
    instruction: "",
    agentId: "gloop",
    settings: {},
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => (i + 1 < args.length ? args[++i]! : undefined);
    const setting = matchSettingFlag(arg, args[i + 1]);
    if (setting) { out.settings[setting.key] = setting.value; if (setting.consumedNext) i++; }
    else if (arg === "--model") out.model = value() ?? out.model;
    else if (arg === "--output") out.outputPath = value() ?? out.outputPath;
    else if (arg === "--provider") out.providerName = value();
    else if (arg === "--session") out.session = value();
    else if (arg === "--agent-id") out.agentId = value() ?? out.agentId;
    else if (arg === "--cause") out.cause = decodeCause(value() ?? "") ?? undefined;
    else if (arg === "--clone") out.clone = true;
    else if (arg === "--debug") out.debug = true;
    else if (arg === "--task") out.instruction = appendTaskPromptSuffix(value() ?? "");
    else if (arg.startsWith("--task=")) out.instruction = appendTaskPromptSuffix(arg.slice("--task=".length));
    else if (!arg.startsWith("--")) out.instruction = arg;
  }
  return out;
}
