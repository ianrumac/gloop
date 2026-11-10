/**
 * shell.ts — Pure process execution, extracted from the Bash tool.
 *
 * No tool-registry awareness, no agent knowledge — just spawn, wait, timeout.
 *
 * Output goes to two temp files rather than pipes.  Nothing has to pump them
 * (so nothing grows in memory or keeps the event loop alive), a command that
 * outlives the background timeout keeps running and keeps writing to them,
 * and `cmd &` inside the shell can't hold a pipe open after `sh` exits.
 * Reading back is bounded: head + tail of each stream.
 *
 * Each command runs in its own process group (`detached`), so a timeout,
 * an interrupt or shutdown kills the whole tree.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { trackChild } from "../src/core/children.ts";

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** Exit status.  124 after a timeout, 130 after an abort, null while still running (backgrounded). */
  exitCode: number | null;
  /** The command outlived `bgTimeoutMs` and was left running. */
  backgrounded: boolean;
  /** Killed because `timeoutMs` expired. */
  timedOut: boolean;
  /** Killed because `signal` fired. */
  aborted: boolean;
  pid: number;
  /** Backgrounded only: how long we waited before detaching (ms). */
  backgroundAfterMs?: number;
  /** Backgrounded only: files the process keeps writing its output to. */
  logFiles?: { stdout: string; stderr: string };
}

export interface ShellOptions {
  command: string;
  /** Kill the command after this long.  When set, the command is never backgrounded. */
  timeoutMs?: number;
  /** Without `timeoutMs`: leave the command running in the background after this long.  Default 60s. */
  bgTimeoutMs?: number;
  /** Kill the command (and its children) when this fires; partial output is returned. */
  signal?: AbortSignal;
  /** Most bytes read back per stream (head + tail are kept).  Default 2 MiB. */
  maxOutputBytes?: number;
  cwd?: string;
}

export const DEFAULT_BG_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Exit codes reported for a killed command — the same ones gloop-loop's node IO uses. */
export const TIMEOUT_EXIT_CODE = 124;
export const ABORT_EXIT_CODE = 130;

/** Send SIGTERM to the process group, escalate to SIGKILL after 250ms.
 *  Falls back to the single process when it isn't a group leader.  Never throws. */
export function killProcessTree(pid: number): void {
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try { process.kill(pid, sig); } catch { /* already gone */ }
    }
  };
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), 250).unref();
}

/**
 * Read at most `maxBytes` of a file: all of it, or its head and tail around
 * a `[… N bytes omitted …]` marker.
 */
export async function readBounded(path: string, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";
  const size = file.size;
  if (size <= maxBytes) return await file.text();
  const half = Math.floor(maxBytes / 2);
  const head = await file.slice(0, half).text();
  const tail = await file.slice(size - half).text();
  return `${head}\n[… ${size - 2 * half} bytes omitted …]\n${tail}`;
}

/** The last `lines` lines of a file, reading no more than its last `maxBytes`. */
async function readTailLines(path: string, lines: number, maxBytes = 64 * 1024): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";
  const text = await file.slice(Math.max(0, file.size - maxBytes)).text();
  return text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
}

type Outcome =
  | { kind: "exit"; code: number }
  | { kind: "timeout" }
  | { kind: "background" }
  | { kind: "abort" };

/** Execute a shell command, returning structured output. */
export async function exec(opts: ShellOptions): Promise<ShellResult> {
  const dir = mkdtempSync(join(tmpdir(), "gloop-bash-"));
  const outPath = join(dir, "stdout.log");
  const errPath = join(dir, "stderr.log");
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const bgAfter = opts.bgTimeoutMs ?? DEFAULT_BG_TIMEOUT_MS;

  const proc = Bun.spawn(["sh", "-c", opts.command], {
    stdin: "ignore",
    stdout: Bun.file(outPath),
    stderr: Bun.file(errPath),
    detached: true,
    cwd: opts.cwd,
  });
  const untrack = trackChild(() => killProcessTree(proc.pid));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const outcome = await new Promise<Outcome>((resolve) => {
    proc.exited.then((code) => resolve({ kind: "exit", code }));
    if (opts.timeoutMs != null) timer = setTimeout(() => resolve({ kind: "timeout" }), opts.timeoutMs);
    else timer = setTimeout(() => resolve({ kind: "background" }), bgAfter);
    if (opts.signal) {
      onAbort = () => resolve({ kind: "abort" });
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  clearTimeout(timer);
  if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  untrack();

  const base = { pid: proc.pid, backgrounded: false, timedOut: false, aborted: false };

  if (outcome.kind === "background") {
    // Leave it running: it writes to the log files, not to us.
    proc.unref();
    return {
      ...base,
      stdout: await readTailLines(outPath, 50),
      stderr: await readTailLines(errPath, 10, 16 * 1024),
      exitCode: null,
      backgrounded: true,
      backgroundAfterMs: bgAfter,
      logFiles: { stdout: outPath, stderr: errPath },
    };
  }

  let exitCode: number;
  if (outcome.kind === "exit") {
    exitCode = outcome.code;
  } else {
    killProcessTree(proc.pid);
    // SIGKILL follows 250ms after SIGTERM; don't wait forever on a zombie.
    await Promise.race([proc.exited, Bun.sleep(1000)]);
    exitCode = outcome.kind === "timeout" ? TIMEOUT_EXIT_CODE : ABORT_EXIT_CODE;
  }

  // A grandchild started with `cmd &` may still hold the files open; it
  // keeps writing to the unlinked inode, which is harmless.
  const [stdout, stderr] = await Promise.all([readBounded(outPath, maxBytes), readBounded(errPath, maxBytes)]);
  rmSync(dir, { recursive: true, force: true });
  return {
    ...base,
    stdout,
    stderr,
    exitCode,
    timedOut: outcome.kind === "timeout",
    aborted: outcome.kind === "abort",
  };
}

/**
 * The status line for a command left running in the background — what the
 * model sees instead of an exit code.
 */
export function formatBackgrounded(r: ShellResult): string {
  const secs = Math.round((r.backgroundAfterMs ?? DEFAULT_BG_TIMEOUT_MS) / 1000);
  let output =
    `Still running in the background after ${secs}s (PID ${r.pid}) — it has not finished and has not failed.`;
  if (r.logFiles) {
    output += `\nIts output keeps going to ${r.logFiles.stdout} (stderr: ${r.logFiles.stderr}).`;
  }
  output += `\nStop it with: kill -- -${r.pid}`;
  if (r.stdout.trim()) output += `\nLast stdout (last 50 lines):\n${r.stdout}`;
  if (r.stderr.trim()) output += `\nLast stderr (last 10 lines):\n${r.stderr}`;
  return output;
}
