import { readdirSync } from "fs";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ToolDefinition } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";
import { exec, formatShellResult } from "../../bin/shell.ts";

const BUILTIN_NAMES = new Set(["ReadFile", "WriteFile", "Patch_file", "Bash", "CompleteTask", "Reload", "Reboot", "AskUser", "ManageContext"]);
const TOOLS_DIR = join(process.cwd(), ".gloop", "tools");

export interface BuiltinOptions {
  clone?: boolean;
}

export function registerBuiltins(registry: ToolRegistry, options: BuiltinOptions = {}): void {

  registry.register({
    name: "ReadFile",
    description: "Read a file from the filesystem",
    arguments: [{ name: "path", description: "The path to the file to read" }],
    execute: async (args) => {
      const file = Bun.file(args.path);
      if (!(await file.exists())) {
        throw new Error(`File not found: ${args.path}`);
      }
      return await file.text();
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
      const file = Bun.file(path);
      if (await file.exists()) {
        const existing = await file.text();
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

      await Bun.write(path, content);
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
      await Bun.write(patchPath, patch.endsWith("\n") ? patch : `${patch}\n`);

      const proc = Bun.spawn(["git", "apply", "--whitespace=nowarn", "--recount", patchPath], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      await unlink(patchPath).catch(() => {});

      if (exitCode !== 0) {
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        throw new Error(details || `git apply failed with exit code ${exitCode}`);
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

      const result = await exec({ command: args.command, timeoutMs });
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
      // Actual interaction is handled by agent.ts via ui.onAskUser
      return args.question || "What would you like to do?";
    },
  });

  if (options.clone) {
    registry.register({
      name: "Reboot",
      description:
        "Save the current conversation history, restart gloop with fresh code, and resume where you left off. Use this after modifying gloop's own codebase so changes take effect.",
      arguments: [
        { name: "reason", description: "Why you are rebooting (shown on resume)" },
      ],
      execute: async (args) => {
        // Actual reboot logic is handled by agent.ts (like CompleteTask)
        return args.reason || "Rebooting...";
      },
    });
  }

  registry.register({
    name: "Reload",
    description: "Reload custom tools from .gloop/tools/ directory",
    arguments: [],
    execute: async () => {
      // Remove all non-builtin tools
      for (const name of registry.names()) {
        if (!BUILTIN_NAMES.has(name)) {
          registry.unregister(name);
        }
      }

      let loaded = 0;
      let errors: string[] = [];

      try {
        const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"));

        for (const file of files) {
          const absPath = join(TOOLS_DIR, file);
          try {
            // Cache-bust dynamic import
            const module = await import(`${absPath}?t=${Date.now()}`);
            const def: ToolDefinition | undefined = module.default;

            if (!def || !def.name || !def.execute) {
              errors.push(`${file}: missing default export with name/execute`);
              continue;
            }

            // Don't let custom tools shadow builtins
            if (BUILTIN_NAMES.has(def.name)) {
              errors.push(`${file}: can't shadow builtin "${def.name}"`);
              continue;
            }

            registry.register(def);
            loaded++;

            // Wire up tool executor for modules that can dispatch calls (e.g. TypeSafeMacros)
            if (typeof module.setToolExecutor === "function") {
              module.setToolExecutor(async (name: string, args: Record<string, string>) => {
                const tool = registry.get(name);
                if (!tool) return `Unknown tool: ${name}`;
                return tool.execute(args);
              });
            }
          } catch (err: any) {
            errors.push(`${file}: ${err.message}`);
          }
        }
      } catch {
        // .gloop/tools/ doesn't exist yet — that's fine
      }

      let result = `Reloaded. ${loaded} custom tool(s) loaded. ${registry.getAll().length} total tools available: [${registry.names().join(", ")}]`;
      if (errors.length) {
        result += `\nErrors:\n${errors.map((e) => `  - ${e}`).join("\n")}`;
      }
      return result;
    },
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
