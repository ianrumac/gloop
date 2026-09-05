import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { EventRef } from "@hypen-space/gloop-loop";
import { newSessionLogPath } from "./session.ts";

export const TASK_PROMPT_SUFFIX =
  "Do not stop working until you think the task is complete, then return the results. make sure to do that by calling task complete tool with the results as arguments .";

export interface TaskRequest {
  task: string;
  model?: string;
  provider?: string;
  debug?: boolean;
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
}

/** Wire-format for `--cause`: `<agent>@<eventId>[@<log>]`. */
export function encodeCause(ref: EventRef): string {
  return [ref.agent, ref.eventId, ref.log ?? ""].join("@");
}

export function decodeCause(raw: string): EventRef | null {
  const parts = raw.split("@");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const log = parts.slice(2).join("@");
  return { agent: parts[0]!, eventId: parts[1]!, ...(log && { log }) };
}

/** Build the argv for a headless child.  Exposed for tests. */
export function buildTaskArgv(
  request: TaskRequest,
  outputPath: string,
  options: { sessionLog: string; agentId: string; cause?: EventRef },
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
  argv.push(prompt);
  return argv;
}

function parseTaskRequestTokens(tokens: string[]): TaskRequest | null {
  let task: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let debug = false;
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

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

  return { task, model, provider, debug };
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

export function parseGloopTaskBashCommand(command: string): TaskRequest | null {
  const tokens = splitShellCommand(command);
  if (!tokens || tokens.length === 0) return null;
  if (!isGloopCommand(tokens[0]!)) return null;
  return parseTaskRequestTokens(tokens.slice(1));
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
  const argv = buildTaskArgv(request, outputPath, { sessionLog, agentId, cause });

  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    cwd: options?.cwd ?? process.cwd(),
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  let summary = "";
  try {
    const text = await Bun.file(outputPath).text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "complete" && typeof event.summary === "string") {
          summary = event.summary;
        }
      } catch {
        // Ignore malformed log lines
      }
    }
  } catch {
    // Ignore missing or unreadable output file
  } finally {
    await unlink(outputPath).catch(() => {});
  }

  const success = exitCode === 0 && summary.length > 0;
  if (!summary) {
    summary = success ? "Task completed." : "Task did not complete.";
  }

  return {
    success,
    summary,
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    agent: agentId,
    log: sessionLog,
  };
}
