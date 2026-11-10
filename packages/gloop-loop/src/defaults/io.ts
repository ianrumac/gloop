/**
 * Default BuiltinIO — Node.js/Bun-compatible file I/O and shell execution.
 *
 * Uses `node:fs/promises` for files and `node:child_process` for shell commands.
 * Works out of the box on Node >= 18 and Bun.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { dirname } from "node:path";
import type { BuiltinIO, ShellResult } from "../tools/builtins.js";

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
// Hard memory safety cap per stream.  What the model sees is capped much
// lower, centrally, by `maxToolOutputChars` (head + tail are kept there).
const MAX_BUFFER = 10 * 1024 * 1024;

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

    exec(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<ShellResult> {
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT;
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve({ stdout: "", stderr: "[interrupted before start]", exitCode: 130, timedOut: false });
          return;
        }
        // The shell leads its own process group so a timeout or interrupt
        // kills everything it started — killing only `sh` would leave e.g.
        // `sleep` holding the pipes open and the call would not return.
        const proc = spawn("/bin/sh", ["-c", command], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "", note = "";
        let settled = false;
        const finish = (exitCode: number, timedOut = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({ stdout, stderr: stderr + note, exitCode, timedOut });
        };
        const killTree = () => {
          try {
            if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
        };
        // Hard memory cap — kill the command rather than buffer without bound.
        const collect = (append: (d: string) => void) => (d: Buffer) => {
          if (stdout.length + stderr.length >= MAX_BUFFER) return;
          append(String(d));
          if (stdout.length + stderr.length >= MAX_BUFFER) {
            note = `\n[output exceeded ${MAX_BUFFER} characters — process killed]`;
            killTree();
            finish(1);
          }
        };
        proc.stdout?.on("data", collect((d) => { stdout += d; }));
        proc.stderr?.on("data", collect((d) => { stderr += d; }));
        proc.on("error", (err) => {
          note = `${stderr ? "\n" : ""}${err.message}`;
          finish(127);
        });
        proc.on("close", (code, sig) => {
          finish(code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1));
        });
        const timer = setTimeout(() => {
          killTree();
          finish(124, true);
        }, timeout);
        const onAbort = () => {
          note = `${stderr ? "\n" : ""}[interrupted — process killed]`;
          killTree();
          finish(130);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        // Ensure the process doesn't keep the event loop alive if parent exits
        proc.unref?.();
      });
    },
  };
}
