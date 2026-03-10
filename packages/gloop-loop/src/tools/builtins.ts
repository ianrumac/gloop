import { applyPatches, parsePatch } from "diff";
import type { ToolDefinition } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import { createNodeIO } from "../defaults/io.js";

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
// primitiveTools — returns the builtin tool definitions as an array
// ---------------------------------------------------------------------------

export function primitiveTools(io?: BuiltinIO): ToolDefinition[] {
  return _buildTools(io ?? createNodeIO());
}

// ---------------------------------------------------------------------------
// registerBuiltins — register all portable builtin tools on a registry
// ---------------------------------------------------------------------------

export function registerBuiltins(
  registry: ToolRegistry,
  io: BuiltinIO,
): void {
  for (const tool of _buildTools(io)) {
    registry.register(tool);
  }
}

function _buildTools(io: BuiltinIO): ToolDefinition[] {
  return [{
    name: "ReadFile",
    description: "Read a file from the filesystem",
    arguments: [{ name: "path", description: "The path to the file to read" }],
    execute: async (args) => {
      const path = args.path!;
      if (!(await io.fileExists(path))) {
        throw new Error(`File not found: ${path}`);
      }
      return await io.readFile(path);
    },
  }, {
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
      const content = args.content!;
      const path = args.path!;

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
  }, {
    name: "Patch_file",
    description: "Apply a unified diff patch to files. Supports both relative and absolute paths in patch headers.",
    arguments: [{ name: "patch", description: "The full unified diff patch text to apply" }],
    execute: async (args) => {
      const patch = args.patch ?? "";
      if (!patch.trim()) {
        throw new Error("Patch_file requires a non-empty patch argument");
      }

      // Strip git-style a/ b/ prefixes from parsed patches so paths resolve correctly
      const parsed = parsePatch(patch);
      for (const file of parsed) {
        if (file.oldFileName) file.oldFileName = file.oldFileName.replace(/^[ab]\//, "");
        if (file.newFileName) file.newFileName = file.newFileName.replace(/^[ab]\//, "");
      }

      const applied: string[] = [];
      const errors: string[] = [];

      await new Promise<void>((resolve, reject) => {
        applyPatches(parsed, {
          loadFile(index, callback) {
            const filePath = index.oldFileName ?? index.newFileName ?? "";
            io.readFile(filePath)
              .then(content => callback(null, content))
              .catch(() => callback(null, "")); // new file — start empty
          },
          patched(index, content, callback) {
            const filePath = index.newFileName ?? index.oldFileName ?? "";
            if (content === false) {
              errors.push(`Failed to apply patch to ${filePath}`);
              callback(null);
              return;
            }
            io.writeFile(filePath, content)
              .then(() => { applied.push(filePath); callback(null); })
              .catch(err => callback(err));
          },
          complete(err) {
            if (err) reject(err);
            else resolve();
          },
        });
      });

      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }

      return `Patch applied successfully to ${applied.length} file(s): ${applied.join(", ")}`;
    },
  }, {
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

      const result = await io.exec(args.command!, timeoutMs);
      return formatShellResult(result);
    },
  }, {
    name: "CompleteTask",
    description:
      "Call this tool when you have finished the user's task. Provide a short summary of what you did. This hands control back to the user.",
    arguments: [
      { name: "summary", description: "A brief summary of what was accomplished" },
    ],
    execute: async (args) => {
      return args.summary || "Task complete.";
    },
  }, {
    name: "AskUser",
    description:
      "Ask the user a question and wait for their response. Use this when you need clarification, a decision, or any input from the user before continuing.",
    arguments: [
      { name: "question", description: "The question to ask the user" },
    ],
    execute: async (args) => {
      return args.question || "What would you like to do?";
    },
  }, {
    name: "Remember",
    description:
      "Store a short note in persistent memory. Use this to remember things about the system, projects, tools, user preferences, or yourself. Store short notes only — never raw command output, full files, or long logs.",
    arguments: [
      { name: "content", description: "The short note to remember" },
    ],
    execute: async (args) => args.content || "",
  }, {
    name: "Forget",
    description:
      "Remove a previously stored note from persistent memory. Use this to clear outdated or incorrect information.",
    arguments: [
      { name: "content", description: "The note to forget (must match what was previously remembered)" },
    ],
    execute: async (args) => args.content || "",
  }, {
    name: "ManageContext",
    description:
      "Start a context management session to review and prune conversation history. Call when context is getting long or cluttered with old tool results.",
    arguments: [
      { name: "instructions", description: "What to focus on when pruning (e.g. 'remove old file reads', 'keep everything about auth')" },
    ],
    execute: async (args) => args.instructions || "Prune stale messages",
  }];
}
