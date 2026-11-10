/**
 * config.ts — gloop's safety settings: defaults, `.gloop/config.json`, flags.
 *
 * Precedence: CLI flag > `.gloop/config.json` > built-in default.  Unknown
 * keys in the file are ignored (noted in the debug log); an invalid value
 * anywhere is a `ConfigError` with a message fit to print at startup.
 *
 * Used by bin/index.ts (interactive), src/core/headless.ts (headless and
 * `--task` children) and the `--task` entry in the launcher, so every mode
 * resolves settings the same way.
 */

import { join } from "path";
import {
  foldTurns,
  llmContextStrategy,
  type AgentLoopOptions,
  type CompactAtTokens,
  type ContextStrategy,
} from "@hypen-space/gloop-loop";
import { DEFAULT_CONTEXT_WINDOW } from "./context-window.ts";

export type CompactionMode = "fold" | "llm";

/**
 * When to compact automatically.  Each figure is a fraction of the model's
 * context window (`0 < x <= 1`) or an absolute token count (an integer
 * `> 1`); `[target, trigger]` (both the same kind, target < trigger)
 * compacts at `trigger` down toward `target`.  `0` = never.
 */
export type CompactAtSetting = number | [number, number];
export type RunMode = "interactive" | "headless";

export interface GloopSettings {
  /** LLM calls per turn before the turn is stopped.  0 = unlimited. */
  maxIterations: number;
  /** Attempts per LLM call (with exponential backoff).  1 = no retry. */
  retries: number;
  /** Cap on each tool result the model sees, in characters.  0 = unlimited. */
  maxToolOutput: number;
  /** When to compact automatically — see `CompactAtSetting`.  Default 0.85 (of the context window). */
  compactAt: CompactAtSetting;
  /** The model's context window in tokens.  Unset = looked up (see context-window.ts). */
  contextWindow?: number;
  /** How automatic compaction trims: fold old turns (no model call) or ask the model. */
  compaction: CompactionMode;
  /** Most recent turns `fold` keeps whole.  Unset = the engine default (3). */
  keepTurns?: number;
  /** Kill a `--task` subagent after this long (ms).  0 = no limit. */
  taskTimeoutMs: number;
  /** Completion-token cap per request.  Unset = the provider's own limit. */
  maxTokens?: number;
  /** Fail a model stream that sends nothing for this long (ms).  Unset = the engine default (2 min); 0 disables. */
  llmIdleTimeoutMs?: number;
}

export type SettingKey = keyof GloopSettings;

/** Settings with a CLI flag.  The rest are config-file only. */
export const SETTING_FLAGS = {
  maxIterations: "--max-iterations",
  retries: "--retries",
  maxToolOutput: "--max-tool-output",
  compactAt: "--compact-at",
  compaction: "--compaction",
  contextWindow: "--context-window",
  taskTimeoutMs: "--task-timeout",
} as const satisfies Partial<Record<SettingKey, string>>;

export type FlagSettingKey = keyof typeof SETTING_FLAGS;
/** Raw flag values as typed on the command line, keyed by setting. */
export type SettingFlags = Partial<Record<FlagSettingKey, string>>;

const FLAG_TO_KEY = new Map<string, FlagSettingKey>(
  Object.entries(SETTING_FLAGS).map(([k, f]) => [f, k as FlagSettingKey]),
);

/**
 * Recognise a setting flag at `arg` (`--max-iterations 50` or
 * `--max-iterations=50`).  `consumedNext` says whether `next` was its value.
 * A flag with no value yields `""`, which `resolveSettings` rejects with a
 * clear message.
 */
export function matchSettingFlag(
  arg: string,
  next: string | undefined,
): { key: FlagSettingKey; value: string; consumedNext: boolean } | null {
  const eq = arg.indexOf("=");
  const key = FLAG_TO_KEY.get(eq === -1 ? arg : arg.slice(0, eq));
  if (!key) return null;
  if (eq !== -1) return { key, value: arg.slice(eq + 1), consumedNext: false };
  if (next === undefined || next.startsWith("--")) return { key, value: "", consumedNext: false };
  return { key, value: next, consumedNext: true };
}

export const CONFIG_FILE = join(".gloop", "config.json");

export function defaultSettings(mode: RunMode): GloopSettings {
  return {
    maxIterations: mode === "interactive" ? 200 : 100,
    retries: 3,
    maxToolOutput: 50_000,
    compactAt: 0.85,
    compaction: "fold",
    taskTimeoutMs: 30 * 60_000,
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ----------------------------------------------------------------------------
// Validation — one rule per key, shared by flags and the file
// ----------------------------------------------------------------------------

type Rule = { expected: string; check: (v: unknown) => boolean };

const nonNegInt: Rule = { expected: "a non-negative integer", check: (v) => Number.isInteger(v) && (v as number) >= 0 };
const posInt: Rule = { expected: "a positive integer", check: (v) => Number.isInteger(v) && (v as number) >= 1 };

const isFraction = (v: unknown): v is number => typeof v === "number" && v > 0 && v <= 1;
const isTokenCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 1;

/** `compactAt`: 0, a fraction, a token count, or `[target, trigger]` of one kind with target < trigger. */
function validCompactAt(v: unknown): boolean {
  if (v === 0 || isFraction(v) || isTokenCount(v)) return true;
  if (!Array.isArray(v) || v.length !== 2) return false;
  const [target, trigger] = v as unknown[];
  const sameKind = (isFraction(target) && isFraction(trigger)) || (isTokenCount(target) && isTokenCount(trigger));
  return sameKind && (target as number) < (trigger as number);
}

const RULES: Record<SettingKey, Rule & { hint?: string }> = {
  maxIterations: { ...nonNegInt, hint: "0 = unlimited" },
  retries: { ...posInt, hint: "1 = no retry" },
  maxToolOutput: { ...nonNegInt, hint: "characters, 0 = unlimited" },
  compactAt: {
    expected: "a fraction of the context window (0 < x <= 1), a token count (> 1), or a range [target, trigger] of one kind with target < trigger",
    hint: "0 = never",
    check: validCompactAt,
  },
  compaction: { expected: '"fold" or "llm"', check: (v) => v === "fold" || v === "llm" },
  contextWindow: { ...posInt, hint: "tokens" },
  keepTurns: posInt,
  taskTimeoutMs: { ...nonNegInt, hint: "milliseconds, 0 = no limit" },
  maxTokens: posInt,
  llmIdleTimeoutMs: { ...nonNegInt, hint: "milliseconds, 0 = disabled" },
};

const KEYS = Object.keys(RULES) as SettingKey[];

function describeRule(key: SettingKey): string {
  const rule = RULES[key];
  return rule.hint ? `${rule.expected} (${rule.hint})` : rule.expected;
}

/** Parse a flag's string value: integers may use `_` separators. */
function parseFlagValue(key: FlagSettingKey, raw: string): unknown {
  if (key === "compaction") return raw;
  if (key === "compactAt") return parseCompactAt(raw);
  const s = raw.replace(/_/g, "");
  return /^-?\d+$/.test(s) ? Number(s) : NaN;
}

/** `0.85`, `120_000`, `0.6-0.85`, `90000..150000` → the setting (NaN when malformed). */
export function parseCompactAt(raw: string): CompactAtSetting {
  const num = (part: string): number => {
    const t = part.trim().replace(/_/g, "");
    return /^(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : NaN;
  };
  const s = raw.trim();
  const parts = s.includes("..") ? s.split("..") : s.split("-");
  if (parts.length === 1) return num(parts[0]!);
  if (parts.length === 2) return [num(parts[0]!), num(parts[1]!)];
  return NaN;
}

/** The setting as a flag value — `0.85`, `120000`, `0.6-0.85`. */
export function formatCompactAt(value: CompactAtSetting): string {
  return Array.isArray(value) ? `${value[0]}-${value[1]}` : String(value);
}

export interface ResolvedSettings {
  settings: GloopSettings;
  /** Where each value came from. */
  sources: Record<SettingKey, "default" | "file" | "flag">;
  /** Things worth a debug-log line (unknown keys, …). */
  notes: string[];
}

/**
 * Merge defaults, the parsed config file and flag strings.  Throws
 * `ConfigError` naming the bad flag or key and what it should be.
 */
export function resolveSettings(input: {
  mode: RunMode;
  /** Parsed `.gloop/config.json` (or undefined when absent). */
  file?: unknown;
  flags?: SettingFlags;
  /** Path shown in file errors.  Default `.gloop/config.json`. */
  filePath?: string;
}): ResolvedSettings {
  const filePath = input.filePath ?? CONFIG_FILE;
  const settings = defaultSettings(input.mode);
  const set = (k: SettingKey, v: unknown) => {
    (settings as unknown as Record<string, unknown>)[k] = v;
  };
  const sources = Object.fromEntries(KEYS.map((k) => [k, "default"])) as ResolvedSettings["sources"];
  const notes: string[] = [];

  if (input.file !== undefined) {
    if (typeof input.file !== "object" || input.file === null || Array.isArray(input.file)) {
      throw new ConfigError(`${filePath}: expected a JSON object of settings.`);
    }
    for (const [key, value] of Object.entries(input.file)) {
      if (key === "$schema") continue;
      if (!(key in RULES)) {
        notes.push(`${filePath}: ignoring unknown key "${key}"`);
        continue;
      }
      const k = key as SettingKey;
      if (!RULES[k].check(value)) {
        throw new ConfigError(`${filePath}: "${k}" must be ${describeRule(k)}, got ${JSON.stringify(value)}.`);
      }
      set(k, value);
      sources[k] = "file";
    }
  }

  for (const [key, raw] of Object.entries(input.flags ?? {})) {
    if (raw === undefined) continue;
    const k = key as FlagSettingKey;
    const value = parseFlagValue(k, raw);
    if (!RULES[k].check(value)) {
      throw new ConfigError(`Invalid ${SETTING_FLAGS[k]} ${JSON.stringify(raw)}: expected ${describeRule(k)}.`);
    }
    set(k, value);
    sources[k] = "flag";
  }

  return { settings, sources, notes };
}

/**
 * Read `<cwd>/.gloop/config.json`.  Undefined when the file doesn't exist;
 * `ConfigError` when it isn't valid JSON.
 */
export async function loadConfigFile(cwd: string = process.cwd()): Promise<unknown> {
  const file = Bun.file(join(cwd, CONFIG_FILE));
  if (!(await file.exists())) return undefined;
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE}: not valid JSON (${(err as Error).message}).`);
  }
}

/** `loadConfigFile` + `resolveSettings` — what the entry points call. */
export async function loadSettings(mode: RunMode, flags: SettingFlags = {}, cwd?: string): Promise<ResolvedSettings> {
  return resolveSettings({ mode, flags, file: await loadConfigFile(cwd) });
}

// ----------------------------------------------------------------------------
// Applying settings
// ----------------------------------------------------------------------------

/** Base delay before the first LLM retry; doubles per attempt (engine caps at 10s). */
const RETRY_BACKOFF_MS = 1000;

/**
 * The context strategy.  The model's own `ManageContext` call always uses
 * the LLM fork (it reviews and summarises, as the system prompt describes);
 * `compaction` picks what the automatic `compactAt` trigger uses.  The
 * engine has one strategy slot for both, so this dispatches on the trigger.
 */
export function contextStrategyFor(settings: Pick<GloopSettings, "compaction" | "keepTurns">): ContextStrategy {
  const llm = llmContextStrategy();
  if (settings.compaction === "llm") return llm;
  const fold = foldTurns(settings.keepTurns !== undefined ? { keep: settings.keepTurns } : {});
  return (graph, ctx) => (ctx.trigger === "tool" ? llm(graph, ctx) : fold(graph, ctx));
}

/**
 * `compactAt` in tokens for a context window: fractions are taken of the
 * window; an absolute trigger above the window is clamped to 95% of it
 * (`notice` says so; a target that no longer fits under it is scaled
 * down with it).  `0` → `0` (off).
 */
export function resolveCompactAt(
  compactAt: CompactAtSetting,
  contextWindow: number,
): { tokens: CompactAtTokens; notice?: string } {
  if (compactAt === 0) return { tokens: 0 };
  const toTokens = (x: number) => (x <= 1 ? Math.floor(x * contextWindow) : x);
  let target = Array.isArray(compactAt) ? toTokens(compactAt[0]) : undefined;
  let trigger = toTokens(Array.isArray(compactAt) ? compactAt[1] : compactAt);
  let notice: string | undefined;
  if (trigger > contextWindow) {
    const was = trigger;
    trigger = Math.floor(contextWindow * 0.95);
    if (target !== undefined && target >= trigger) target = Math.floor((target * trigger) / was);
    notice =
      `compactAt ${was} is above the model's ${contextWindow}-token context window; compacting at ${trigger}` +
      (target !== undefined ? ` (target ${target})` : "") + " instead.";
  }
  if (target !== undefined && !(target < trigger)) target = undefined;
  return { tokens: target !== undefined ? { trigger, target } : trigger, ...(notice && { notice }) };
}

/** The `AgentLoop` options these settings translate to, for a model with this context window. */
export function agentOptionsFor(settings: GloopSettings, contextWindow: number = DEFAULT_CONTEXT_WINDOW): Pick<
  AgentLoopOptions,
  "maxIterations" | "retry" | "maxToolOutputChars" | "context" | "maxTokens" | "llmIdleTimeoutMs"
> {
  return {
    maxIterations: settings.maxIterations,
    retry: settings.retries > 1 ? { llm: { attempts: settings.retries, backoffMs: RETRY_BACKOFF_MS } } : undefined,
    maxToolOutputChars: settings.maxToolOutput,
    context: {
      strategy: contextStrategyFor(settings),
      compactAtTokens: resolveCompactAt(settings.compactAt, contextWindow).tokens,
    },
    ...(settings.maxTokens !== undefined && { maxTokens: settings.maxTokens }),
    ...(settings.llmIdleTimeoutMs !== undefined && { llmIdleTimeoutMs: settings.llmIdleTimeoutMs }),
  };
}

/**
 * Flags that hand this process's settings to a `--task` child.  Only values
 * that were set explicitly (flag or file) are passed, so defaults resolve
 * for the child's own mode (e.g. a task's 100-iteration cap).  File-only
 * keys reach the child through the same `.gloop/config.json` (same cwd).
 */
export function inheritedFlags(resolved: ResolvedSettings): SettingFlags {
  const out: SettingFlags = {};
  for (const key of Object.keys(SETTING_FLAGS) as FlagSettingKey[]) {
    if (resolved.sources[key] === "default") continue;
    const value = resolved.settings[key];
    if (value === undefined) continue;
    out[key] = key === "compactAt" ? formatCompactAt(value as CompactAtSetting) : String(value);
  }
  return out;
}

/** `SettingFlags` as argv: `["--max-iterations", "50", …]`. */
export function flagsToArgv(flags: SettingFlags): string[] {
  const argv: string[] = [];
  for (const key of Object.keys(SETTING_FLAGS) as FlagSettingKey[]) {
    const value = flags[key];
    if (value !== undefined) argv.push(SETTING_FLAGS[key], value);
  }
  return argv;
}

/**
 * The one-line startup error for a missing API key, or null when the key is
 * set or `OPENROUTER_BASE_URL` points at an endpoint that may not need one.
 */
export function missingApiKeyMessage(env: Record<string, string | undefined> = process.env): string | null {
  if (env.OPENROUTER_API_KEY || env.OPENROUTER_BASE_URL) return null;
  return "gloop: OPENROUTER_API_KEY is not set. Get a key at https://openrouter.ai/keys and `export OPENROUTER_API_KEY=…` (or set OPENROUTER_BASE_URL for a local endpoint).";
}

/** One line for the system prompt about the tool-output cap, or "" when uncapped. */
export function toolOutputCapNote(maxToolOutput: number): string {
  if (maxToolOutput <= 0) return "";
  return `Tool results longer than ${maxToolOutput.toLocaleString("en-US")} characters are cut to their head and tail — narrow commands (grep, head, tail, line ranges) instead of dumping large output.`;
}
