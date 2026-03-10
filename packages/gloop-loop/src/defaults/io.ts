/**
 * Default BuiltinIO — Node.js/Bun-compatible file I/O and shell execution.
 *
 * Uses `node:fs/promises` for files and `node:child_process` for shell commands.
 * Works out of the box on Node >= 18 and Bun.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { exec as cpExec } from "node:child_process";
import { dirname } from "node:path";
import type { BuiltinIO, ShellResult } from "../tools/builtins.js";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const MAX_OUTPUT = 100_000; // 100KB per stream

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...(truncated, ${s.length - max} bytes omitted)`;
}

export function createNodeIO(): BuiltinIO {
  return {
    async readFile(path: string): Promise<string> {
      return readFile(path, "utf-8");
    },

    async fileExists(path: string): Promise<boolean> {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },

    async writeFile(path: string, content: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
    },

    exec(command: string, timeoutMs?: number): Promise<ShellResult> {
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT;
      return new Promise((resolve) => {
        const proc = cpExec(
          command,
          { timeout, maxBuffer: 10 * 1024 * 1024, shell: "/bin/sh" },
          (error, stdout, stderr) => {
            const timedOut = error?.killed === true;
            const exitCode = timedOut
              ? 124
              : (error as NodeJS.ErrnoException & { code?: number })?.code === 1
                ? 1
                : error
                  ? (error as { status?: number }).status ?? 1
                  : 0;
            resolve({
              stdout: truncate(String(stdout), MAX_OUTPUT),
              stderr: truncate(String(stderr), MAX_OUTPUT),
              exitCode,
              timedOut,
            });
          },
        );
        // Ensure the process doesn't keep the event loop alive if parent exits
        proc.unref?.();
      });
    },
  };
}
