/**
 * Argument parsing for the interactive CLI (bin/index.ts), kept separate so
 * it can be unit-tested without launching the agent.
 */

import { DEFAULT_GLOOP_MODEL } from "./default-model.ts";

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
}

const takesValue = new Set(["--provider", "--resume"]);

export function parseGloopArgs(args: string[]): GloopCliArgs {
  const out: GloopCliArgs = {
    clone: false,
    debug: false,
    resume: { requested: false },
    model: DEFAULT_GLOOP_MODEL,
  };
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    if (a === "--clone") out.clone = true;
    else if (a === "--debug") out.debug = true;
    else if (a === "--provider") { if (hasValue) out.providerName = args[++i]; }
    else if (a === "--resume") { out.resume.requested = true; if (hasValue) out.resume.path = args[++i]; }
    else if (a.startsWith("--")) { if (takesValue.has(a) && hasValue) i++; }
    else if (model === undefined) model = a;
  }

  if (model !== undefined) out.model = model;
  return out;
}
