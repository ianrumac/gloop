import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ToolDefinition } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";

// ---------------------------------------------------------------------------
// IO interface — abstracts runtime-specific file and process operations
// ---------------------------------------------------------------------------

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface BuiltinIO {
  /** Read a file's text content. Throw if not found. */
  readFile(path: string): Promise<string>;
  /** Check whether a file exists. */
  fileExists(path: string): Promise<boolean>;
  /** Write text content to a file (create or overwrite). */
  writeFile(path: string, content: string): Promise<void>;
  /** Execute a shell command. Return structured result. */
  exec(command: string, timeoutMs?: number): Promise<ShellResult>;
}

// ---------------------------------------------------------------------------
// formatShellResult — portable shell result formatter
// ---------------------------------------------------------------------------

export function formatShellResult(result: ShellResult): string {
  const parts: string[] = [];

  if (result.timedOut) {
    parts.push("[command timed out]");
  }

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);

  if (!stdout && !stderr) {
    parts.push(result.exitCode === 0 ? "(no output)" : `(exit code ${result.exitCode})`);
  } else if (result.exitCode !== 0) {
    parts.push(`(exit code ${result.exitCode})`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// registerBuiltins — register all portable builtin tools
// ---------------------------------------------------------------------------

export function registerBuiltins(
  registry: ToolRegistry,
  io: BuiltinIO,
): void {
  registry.register({
    name: "ReadFile",
    description: "Read a file from the filesystem",
    arguments: [{ name: "path", description: "The path to the file to read" }],
    execute: async (args) => {
      if (!(await io.fileExists(args.path))) {
        throw new Error(`File not found: ${args.path}`);
      }
      return await io.readFile(args.path);
    },
  });

  registry.register({
    name: "WriteFile",
    description:
      "Write LITERAL file content to a file. The content argument MUST be the complete, exact text to write — NOT a description or instruction of what to write. For example: WriteFile(\"foo.ts\", \"export const x = 1;\\n\") is correct. WriteFile(\"foo.ts\", \"Add an export\") is WRONG — that would write the literal string 'Add an export' into the file.",
    arguments: [
      { name: "path", description: "The path to the file to write to" },
      {
        name: "content",
        description:
          "The EXACT, LITERAL text content to write to the file. This is NOT a description — it is the raw file content.",
      },
    ],
    execute: async (args) => {
      const content = args.content;
      const path = args.path;

      // Guard: if the file already exists and new content is suspiciously short,
      // it's likely the model passed a description instead of real content.
      if (await io.fileExists(path)) {
        const existing = await io.readFile(path);
        if (
          existing.length > 200 &&
          content.length < 100 &&
          !/[{};()=<>\/\\]/.test(content)
        ) {
          throw new Error(
            `Refusing to overwrite ${path} (${existing.length} bytes) with ${content.length} bytes of what looks like a description, not code. ` +
              `Provide the full literal file content.`,
          );
        }
      }

      await io.writeFile(path, content);
      return `Successfully wrote ${content.length} bytes to ${path}`;
    },
  });

  registry.register({
    name: "Patch_file",
    description: "Apply a git-style unified diff patch to files in the current working directory",
    arguments: [{ name: "patch", description: "The full git-style unified diff patch text to apply" }],
    execute: async (args) => {
      const patch = args.patch ?? "";
      if (!patch.trim()) {
        throw new Error("Patch_file requires a non-empty patch argument");
      }

      const patchPath = join(tmpdir(), `gloop-patch-${randomUUID()}.diff`);
      await io.writeFile(patchPath, patch.endsWith("\n") ? patch : `${patch}\n`);

      const result = await io.exec(`git apply --whitespace=nowarn --recount ${patchPath}`);

      await unlink(patchPath).catch(() => {});

      if (result.exitCode !== 0) {
        const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
        throw new Error(details || `git apply failed with exit code ${result.exitCode}`);
      }

      return "Patch applied successfully.";
    },
  });

  registry.register({
    name: "Bash",
    description:
      "Execute a command in the shell. For long-running commands (servers/watchers), run them in the background (e.g. `... > /tmp/file.log 2>&1 &`) and then inspect logs in follow-up commands so the session does not block.",
    arguments: [
      { name: "command", description: "The command to execute" },
      { name: "timeoutMs", description: "Optional timeout in milliseconds (e.g. 30000). If exceeded, the command is terminated." },
    ],
    askPermission: (args) => {
      const cmd = args.command ?? "";
      const dangerous = [/\brm\b/, /\brmdir\b/, /\brm\s+-rf?\b/, /\brm\s+-fr?\b/];
      for (const pattern of dangerous) {
        if (pattern.test(cmd)) return cmd;
      }
      return null;
    },
    execute: async (args) => {
      let timeoutMs: number | undefined;
      if (args.timeoutMs !== undefined && args.timeoutMs !== "") {
        const parsed = Number.parseInt(args.timeoutMs, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid timeoutMs: ${args.timeoutMs}. Expected a positive integer.`);
        }
        timeoutMs = parsed;
      }

      const result = await io.exec(args.command, timeoutMs);
      return formatShellResult(result);
    },
  });

  registry.register({
    name: "CompleteTask",
    description:
      "Call this tool when you have finished the user's task. Provide a short summary of what you did. This hands control back to the user.",
    arguments: [
      { name: "summary", description: "A brief summary of what was accomplished" },
    ],
    execute: async (args) => {
      return args.summary || "Task complete.";
    },
  });

  registry.register({
    name: "AskUser",
    description:
      "Ask the user a question and wait for their response. Use this when you need clarification, a decision, or any input from the user before continuing.",
    arguments: [
      { name: "question", description: "The question to ask the user" },
    ],
    execute: async (args) => {
      return args.question || "What would you like to do?";
    },
  });

  registry.register({
    name: "Remember",
    description:
      "Store a short note in persistent memory. Use this to remember things about the system, projects, tools, user preferences, or yourself. Store short notes only — never raw command output, full files, or long logs.",
    arguments: [
      { name: "content", description: "The short note to remember" },
    ],
    execute: async (args) => args.content || "",
  });

  registry.register({
    name: "Forget",
    description:
      "Remove a previously stored note from persistent memory. Use this to clear outdated or incorrect information.",
    arguments: [
      { name: "content", description: "The note to forget (must match what was previously remembered)" },
    ],
    execute: async (args) => args.content || "",
  });

  registry.register({
    name: "ManageContext",
    description:
      "Start a context management session to review and prune conversation history. Call when context is getting long or cluttered with old tool results.",
    arguments: [
      { name: "instructions", description: "What to focus on when pruning (e.g. 'remove old file reads', 'keep everything about auth')" },
    ],
    execute: async (args) => args.instructions || "Prune stale messages",
  });
}
