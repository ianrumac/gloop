import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import os, { tmpdir } from "os";
import { join } from "path";
import type { EventRef, Usage } from "@hypen-space/gloop-loop";
import { newSessionLogPath } from "./session.ts";
import {
  ConfigError,
  flagsToArgv,
  loadSettings,
  matchSettingFlag,
  missingApiKeyMessage,
  type ResolvedSettings,
  type SettingFlags,
} from "./config.ts";
import { trackChild } from "./children.ts";

export const TASK_PROMPT_SUFFIX =
  "Do not stop working until you think the task is complete, then return the results. make sure to do that by calling task complete tool with the results as arguments .";

export interface TaskRequest {
  task: string;
  model?: string;
  provider?: string;
  debug?: boolean;
  /** Safety-setting flags given with the task (`--max-iterations 20` …). */
  settings?: SettingFlags;
}

export interface TaskRunResult {
  success: boolean;
  summary: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Agent id the child stamped on its events. */
  agent?: string;
  /** Path of the child's session event log. */
  log?: string;
  /** The child's token totals, from its final `usage` event. */
  usage?: Usage;
  /** The child was killed because it ran past its time limit. */
  timedOut?: boolean;
}

export interface TaskRunOptions {
  cwd?: string;
  /**
   * The parent's `spawn_start` event.  Passed to the child as `--cause` so
   * the child's first message records it, linking the two logs.
   */
  cause?: EventRef;
  /** The parent's session log path — stored on the child's `cause.log`. */
  parentLog?: string;
  /** Override the child's log path / agent id (tests). */
  sessionLog?: string;
  agentId?: string;
  /** The parent's explicit settings, passed on as flags (the request's own flags win). */
  inheritFlags?: SettingFlags;
  /** Kill the child after this long (ms).  0 / unset = no limit.  A valid `--task-timeout` in the request wins. */
  timeoutMs?: number;
  /** Kill the child when this fires (the parent's turn was interrupted). */
  signal?: AbortSignal;
  /** Override the child's argv, given the JSONL path it should write (tests). */
  argv?: (outputPath: string) => string[];
  /** Grace period between SIGTERM and SIGKILL when stopping the child.  Default 3s. */
  killGraceMs?: number;
}

/** Wire format for `--cause`: the `EventRef` as JSON — no delimiter edge cases. */
export function encodeCause(ref: EventRef): string {
  return JSON.stringify({ agent: ref.agent, eventId: ref.eventId, ...(ref.log && { log: ref.log }) });
}

export function decodeCause(raw: string): EventRef | null {
  try {
    const v = JSON.parse(raw) as Partial<EventRef>;
    if (typeof v?.agent !== "string" || typeof v.eventId !== "string") return null;
    return { agent: v.agent, eventId: v.eventId, ...(typeof v.log === "string" && v.log && { log: v.log }) };
  } catch {
    return null;
  }
}

/** Build the argv for a headless child.  Exposed for tests. */
export function buildTaskArgv(
  request: TaskRequest,
  outputPath: string,
  options: { sessionLog: string; agentId: string; cause?: EventRef; flags?: SettingFlags },
): string[] {
  const prompt = appendTaskPromptSuffix(request.task);
  const argv = [
    "bun",
    join(import.meta.dirname, "headless.ts"),
    "--output", outputPath,
    "--session", options.sessionLog,
    "--agent-id", options.agentId,
  ];
  if (options.cause) argv.push("--cause", encodeCause(options.cause));
  if (request.model) argv.push("--model", request.model);
  if (request.provider) argv.push("--provider", request.provider);
  if (request.debug) argv.push("--debug");
  argv.push(...flagsToArgv(options.flags ?? request.settings ?? {}));
  argv.push(prompt);
  return argv;
}

function parseTaskRequestTokens(tokens: string[]): TaskRequest | null {
  let task: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let debug = false;
  const settings: SettingFlags = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    const setting = matchSettingFlag(token, tokens[i + 1]);
    if (setting) {
      settings[setting.key] = setting.value;
      if (setting.consumedNext) i++;
      continue;
    }

    if (token === "--task" && i + 1 < tokens.length) {
      task = tokens[++i]!;
      continue;
    }
    if (token.startsWith("--task=")) {
      task = token.slice("--task=".length);
      continue;
    }

    if (token === "--model" && i + 1 < tokens.length) {
      model = tokens[++i]!;
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
      continue;
    }

    if (token === "--provider" && i + 1 < tokens.length) {
      provider = tokens[++i]!;
      continue;
    }
    if (token.startsWith("--provider=")) {
      provider = token.slice("--provider=".length);
      continue;
    }

    if (token === "--debug") {
      debug = true;
      continue;
    }

    if (!token.startsWith("--")) {
      positional.push(token);
    }
  }

  if (!task) return null;
  if (!model && positional.length > 0) model = positional[0];

  return { task, model, provider, debug, ...(Object.keys(settings).length > 0 && { settings }) };
}

export function appendTaskPromptSuffix(task: string): string {
  const trimmed = task.trim();
  if (!trimmed) return TASK_PROMPT_SUFFIX;
  if (trimmed.includes(TASK_PROMPT_SUFFIX)) return trimmed;
  return `${trimmed}\n\n${TASK_PROMPT_SUFFIX}`;
}

export function parseTaskCliArgs(args: string[]): TaskRequest | null {
  return parseTaskRequestTokens(args);
}

export function splitShellCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote) {
      if (quote !== "'" && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaped || quote) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function isGloopCommand(token: string): boolean {
  const name = token.split("/").pop() ?? token;
  return name === "gloop";
}

/**
 * Does the command do anything besides run one program — a shell operator
 * (`&&`, `|`, `;`, `&`), a redirection, a subshell, or an expansion
 * (`$VAR`, `$(…)`, backticks) — outside single quotes?
 */
export function hasShellSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") return true;
    if (ch === "$" && /[A-Za-z_{(0-9?!@*#$-]/.test(command[i + 1] ?? "")) return true;
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (";&|<>()\n".includes(ch)) return true;
  }
  return false;
}

/**
 * Parse a Bash call that is exactly one `gloop --task …` invocation.  Anything
 * more (`gloop --task x && echo done`, `> out.txt`, `$(…)`) is not a spawn —
 * it runs as a normal shell command, so nothing after the task is dropped.
 */
export function parseGloopTaskBashCommand(command: string): TaskRequest | null {
  if (hasShellSyntax(command)) return null;
  const tokens = splitShellCommand(command);
  if (!tokens || tokens.length === 0) return null;
  if (!isGloopCommand(tokens[0]!)) return null;
  return parseTaskRequestTokens(tokens.slice(1));
}

/**
 * Collect a stream's text, keeping at most `maxChars` (head + tail).
 * `text()` is readable at any time; `cancel()` stops reading (a grandchild
 * may hold the pipe open after the child itself has exited).
 */
function captureCapped(stream: ReadableStream<Uint8Array>, maxChars = 256 * 1024) {
  const half = Math.floor(maxChars / 2);
  const dec = new TextDecoder();
  let head = "";
  let tail = "";
  let dropped = 0;
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let text = dec.decode(value, { stream: true });
        if (head.length < half) {
          const take = half - head.length;
          head += text.slice(0, take);
          text = text.slice(take);
        }
        tail += text;
        if (tail.length > half) {
          dropped += tail.length - half;
          tail = tail.slice(-half);
        }
      }
    } catch {
      // Stream closed under us — keep what we have.
    }
  })();
  return {
    done,
    text: () => (dropped > 0 ? `${head}\n[… ${dropped} characters omitted …]\n${tail}` : head + tail),
    cancel: () => reader.cancel().catch(() => {}),
  };
}

/** A positive `--task-timeout` value from the request, else undefined. */
function requestTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.replace(/_/g, ""))) return undefined;
  return Number(raw.replace(/_/g, ""));
}

/** Read the child's JSONL output: its CompleteTask summary and final token totals. */
async function readTaskOutput(outputPath: string): Promise<{ summary: string; usage?: Usage }> {
  let summary = "";
  let usage: Usage | undefined;
  try {
    const text = await Bun.file(outputPath).text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "complete" && typeof event.summary === "string") {
          summary = event.summary;
        }
        if (event.type === "usage" && typeof event.totalTokens === "number") {
          usage = {
            promptTokens: Number(event.promptTokens) || 0,
            completionTokens: Number(event.completionTokens) || 0,
            totalTokens: event.totalTokens,
          };
        }
      } catch {
        // Ignore malformed log lines
      }
    }
  } catch {
    // Ignore missing or unreadable output file
  }
  return { summary, usage };
}

export async function runTaskSubagent(
  request: TaskRequest,
  options: TaskRunOptions = {},
): Promise<TaskRunResult> {
  const outputPath = join(tmpdir(), `gloop-task-${randomUUID()}.jsonl`);
  const short = randomUUID().slice(0, 8);
  const agentId = options.agentId ?? `gloop/task-${short}`;
  const sessionLog = options.sessionLog ?? newSessionLogPath(new Date(), `task-${short}`);
  const cause: EventRef | undefined = options.cause
    ? { ...options.cause, ...(options.parentLog && { log: options.parentLog }) }
    : undefined;
  const flags: SettingFlags = { ...options.inheritFlags, ...request.settings };
  const argv = options.argv?.(outputPath) ?? buildTaskArgv(request, outputPath, { sessionLog, agentId, cause, flags });
  const timeoutMs = requestTimeout(request.settings?.taskTimeoutMs) ?? options.timeoutMs ?? 0;

  // Its own process group: a terminal Ctrl+C reaches the parent, which
  // decides; stopping the child is a SIGTERM (it stops its agent and its own
  // children), then SIGKILL for the group after a grace period.
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    cwd: options?.cwd ?? process.cwd(),
    detached: true,
  });

  let exited = false;
  let stoppedBy: "timeout" | "abort" | null = null;
  const terminate = () => {
    if (exited) return;
    try { process.kill(proc.pid, "SIGTERM"); } catch { /* gone */ }
    // The group, even if the child itself is gone: leftovers die with it.
    setTimeout(() => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* group gone */ }
    }, options.killGraceMs ?? 3000).unref();
  };
  const stop = (why: "timeout" | "abort") => {
    if (exited || stoppedBy) return;
    stoppedBy = why;
    terminate();
  };
  const untrack = trackChild(terminate);
  const timer = timeoutMs > 0 ? setTimeout(() => stop("timeout"), timeoutMs) : undefined;
  const onAbort = () => stop("abort");
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const out = captureCapped(proc.stdout);
  const err = captureCapped(proc.stderr);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
    // Give the pipes a moment to drain, but don't wait on a grandchild
    // that inherited them.
    await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(500)]);
    void out.cancel();
    void err.cancel();
  } finally {
    exited = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    untrack();
  }

  let { summary, usage } = await readTaskOutput(outputPath);
  await unlink(outputPath).catch(() => {});

  const success = stoppedBy === null && exitCode === 0 && summary.length > 0;
  if (stoppedBy === "timeout") {
    summary = `Task timed out after ${formatDuration(timeoutMs)} and was killed.${summary ? ` Last summary: ${summary}` : ""}`;
  } else if (stoppedBy === "abort") {
    summary = "Task was interrupted and killed.";
  } else if (!summary) {
    summary = success ? "Task completed." : "Task did not complete.";
  }

  return {
    success,
    summary,
    exitCode: stoppedBy === "timeout" ? 124 : stoppedBy === "abort" ? 130 : exitCode,
    stdout: out.text().trim(),
    stderr: err.text().trim(),
    agent: agentId,
    log: sessionLog,
    ...(usage && { usage }),
    ...(stoppedBy === "timeout" && { timedOut: true }),
  };
}

/** `90000` → `"1m 30s"`. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export interface TaskSpawnParent {
  model: string;
  provider?: string;
  cwd: string;
  /** The parent's session log — the children's `cause.log`. */
  parentLog: string;
  /** The parent's explicit settings as flags (see `inheritedFlags`). */
  inheritFlags: SettingFlags;
  /** Default time limit per child (`taskTimeoutMs`). */
  timeoutMs: number;
}

/**
 * `classifySpawn` + `spawn` for an `AgentLoop`: a Bash call that is exactly
 * `gloop --task "…" [flags]` runs as a linked subagent.  The engine hands
 * `spawn` only the task text, so the parsed request (model, provider,
 * setting flags) is remembered by task between the two calls.
 */
export function taskSpawnOptions(parent: TaskSpawnParent): {
  classifySpawn: (call: { name: string; args: Record<string, string> }) => string | null;
  spawn: (task: string, call: { cause?: EventRef; signal?: AbortSignal }) => Promise<TaskRunResult>;
} {
  const requests = new Map<string, TaskRequest>();
  return {
    classifySpawn: (call) => {
      if (call.name !== "Bash") return null;
      const req = parseGloopTaskBashCommand(call.args.command ?? "");
      if (!req) return null;
      requests.set(req.task, req);
      return req.task;
    },
    spawn: (task, call) => {
      const req = requests.get(task);
      requests.delete(task);
      return runTaskSubagent(
        {
          task,
          model: req?.model ?? parent.model,
          provider: req?.provider ?? parent.provider,
          debug: req?.debug,
          settings: req?.settings,
        },
        {
          cwd: parent.cwd,
          cause: call.cause,
          parentLog: parent.parentLog,
          inheritFlags: parent.inheritFlags,
          timeoutMs: parent.timeoutMs,
          signal: call.signal,
        },
      );
    },
  };
}

/**
 * `gloop --task "…"` from the command line: resolve settings, check the API
 * key, run the task as a headless child, print its summary.  Returns the
 * process exit code.  A signal kills the child (it gets SIGTERM, stops its
 * agent and children, and logs a final event); a second one exits at once.
 */
export async function runTaskCli(request: TaskRequest, cwd: string = process.cwd()): Promise<number> {
  const missingKey = missingApiKeyMessage();
  if (missingKey) {
    console.error(missingKey);
    return 1;
  }
  let resolved: ResolvedSettings;
  try {
    // The child resolves the same file itself; validate early for a clean error.
    resolved = await loadSettings("headless", request.settings ?? {}, cwd);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`gloop: ${err.message}`);
    return 1;
  }

  const ac = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    if (ac.signal.aborted) process.exit(128 + (os.constants.signals[sig] ?? 2));
    ac.abort();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const sig of signals) process.on(sig, onSignal);
  try {
    const result = await runTaskSubagent(request, {
      cwd,
      timeoutMs: resolved.settings.taskTimeoutMs,
      signal: ac.signal,
    });
    if (result.success) {
      console.log(result.summary);
      return 0;
    }
    console.error(`Task mode failed: ${result.summary}`);
    if (result.stderr) console.error(result.stderr);
    if (result.stdout) console.error(result.stdout);
    return result.exitCode === 0 ? 1 : result.exitCode;
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
  }
}
