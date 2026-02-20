import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

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
  options?: { cwd?: string },
): Promise<TaskRunResult> {
  const outputPath = join(tmpdir(), `gloop-task-${randomUUID()}.jsonl`);
  const prompt = appendTaskPromptSuffix(request.task);

  const argv = ["bun", join(import.meta.dirname, "headless.ts"), "--output", outputPath];
  if (request.model) argv.push("--model", request.model);
  if (request.provider) argv.push("--provider", request.provider);
  if (request.debug) argv.push("--debug");
  argv.push(prompt);

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
  };
}
