import { readdirSync } from "fs";
import { join } from "path";
import type { ToolDefinition } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";
import {
  createInvokeSkillTool,
  registerBuiltins as libRegisterBuiltins,
  type BuiltinIO,
  type ShellResult,
  type Skill,
} from "@hypen-space/gloop-loop";
import { exec as shellExec, formatBackgrounded, type ShellResult as GloopShellResult } from "../../bin/shell.ts";

/** Thrown by the Reboot tool — caught by the outer run loop to trigger process restart. */
export class RebootError extends Error {
  constructor(public readonly reason: string) {
    super(`Reboot: ${reason}`);
    this.name = "RebootError";
  }
}

const BUILTIN_NAMES = new Set([
  "ReadFile",
  "WriteFile",
  "Patch_file",
  "Bash",
  "CompleteTask",
  "Reload",
  "Reboot",
  "AskUser",
  "ManageContext",
  "Remember",
  "Forget",
  "InvokeSkill",
]);
const TOOLS_DIR = join(process.cwd(), ".gloop", "tools");

/**
 * Map a shell.ts result onto the lib's `ShellResult`, which the lib's Bash
 * tool formats for the model.  A command left running in the background is
 * not a failure: it reports exit code 0 with the "still running, PID …"
 * status as its output, so the model sees that instead of `(exit code 1)`.
 */
export function toBuiltinShellResult(r: GloopShellResult): ShellResult {
  if (r.backgrounded) return { stdout: formatBackgrounded(r), stderr: "", exitCode: 0 };
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode ?? 1,
    timedOut: r.timedOut,
  };
}

export interface BunIOOptions {
  /** Leave a Bash command without `timeoutMs` running in the background after this long.  Default 60s. */
  bashBackgroundAfterMs?: number;
}

/** Bun-specific IO adapter for the lib's builtin tools */
export function createBunIO(options: BunIOOptions = {}): BuiltinIO {
  return {
    async readFile(path: string) {
      const file = Bun.file(path);
      return await file.text();
    },
    async fileExists(path: string) {
      return await Bun.file(path).exists();
    },
    async writeFile(path: string, content: string) {
      await Bun.write(path, content);
    },
    async exec(command: string, timeoutMs?: number, signal?: AbortSignal) {
      const result = await shellExec({ command, timeoutMs, signal, bgTimeoutMs: options.bashBackgroundAfterMs });
      return toBuiltinShellResult(result);
    },
  };
}

export interface BuiltinOptions extends BunIOOptions {
  clone?: boolean;
  /** When set, registers InvokeSkill so the agent can load skill bodies by name. */
  skills?: Skill[];
}

export function registerBuiltins(registry: ToolRegistry, options: BuiltinOptions = {}): void {
  // Register all portable builtins from the lib
  libRegisterBuiltins(registry, createBunIO(options));

  const invokeSkill = createInvokeSkillTool(options.skills ?? []);
  if (invokeSkill) registry.register(invokeSkill);

  // Gloop-specific: Reboot tool (only in clone mode)
  if (options.clone) {
    registry.register({
      name: "Reboot",
      description:
        "Save the current conversation history, restart with fresh code, and resume where you left off. Use this after modifying the agent's own codebase so changes take effect.",
      arguments: [
        { name: "reason", description: "Why you are rebooting (shown on resume)" },
      ],
      execute: async (args) => {
        throw new RebootError(args.reason || "Reboot requested");
      },
    });
  }

  // Gloop-specific: Reload custom tools from .gloop/tools/
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
            const module = await import(`${absPath}?t=${Date.now()}`);
            const def: ToolDefinition | undefined = module.default;

            if (!def || !def.name || !def.execute) {
              errors.push(`${file}: missing default export with name/execute`);
              continue;
            }

            if (BUILTIN_NAMES.has(def.name)) {
              errors.push(`${file}: can't shadow builtin "${def.name}"`);
              continue;
            }

            registry.register(def);
            loaded++;

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
}
