/**
 * shell.ts — Pure process execution, extracted from the Bash tool.
 *
 * No tool-registry awareness, no agent knowledge — just spawn, pump, timeout.
 */

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  backgrounded: boolean;
  pid: number;
}

export interface ShellOptions {
  command: string;
  timeoutMs?: number;
  bgTimeoutMs?: number;
}

/** Send SIGTERM to the process group, escalate to SIGKILL after 250ms.
 *  Silently ignores ESRCH (process already gone). */
export function killProcessTree(pid: number): void {
  const signal = (target: number, sig: string) => {
    try { process.kill(target, sig); }
    catch (e: any) { if (e?.code !== "ESRCH") throw e; }
  };

  try { signal(-pid, "SIGTERM"); }
  catch { signal(pid, "SIGTERM"); }

  setTimeout(() => {
    try { signal(-pid, "SIGKILL"); }
    catch { signal(pid, "SIGKILL"); }
  }, 250);
}

/** Execute a shell command, returning structured output. */
export async function exec(opts: ShellOptions): Promise<ShellResult> {
  const proc = Bun.spawn(["sh", "-c", opts.command], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Incrementally accumulate output so we can report partial results on timeout
  let stdoutBuf = "";
  let stderrBuf = "";
  const dec = new TextDecoder();
  // Pumps swallow errors: stream can break when the process exits or is killed
  const pumpStdout = (async () => {
    try { for await (const c of proc.stdout) stdoutBuf += dec.decode(c, { stream: true }); }
    catch (_: unknown) { /* stream closed */ }
  })();
  const pumpStderr = (async () => {
    try { for await (const c of proc.stderr) stderrBuf += dec.decode(c, { stream: true }); }
    catch (_: unknown) { /* stream closed */ }
  })();

  // Explicit timeout: kill process on expiry
  if (opts.timeoutMs != null) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          killProcessTree(proc.pid);
          reject(new Error(`Command timed out after ${opts.timeoutMs}ms.`));
        }, opts.timeoutMs!);
      });
      const exitCode = await Promise.race([proc.exited, timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      await Promise.all([pumpStdout, pumpStderr]);
      return { stdout: stdoutBuf, stderr: stderrBuf, exitCode, backgrounded: false, pid: proc.pid };
    } catch (_err: any) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // On timeout, still return what we have
      return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: null, backgrounded: false, pid: proc.pid };
    }
  }

  // No explicit timeout: background timeout (default 60s) — don't kill, just detach
  const BG_TIMEOUT_MS = opts.bgTimeoutMs ?? 60_000;
  let bgHandle: ReturnType<typeof setTimeout> | undefined;
  const bgResult = await Promise.race([
    proc.exited.then(code => ({ type: "exit" as const, code })),
    new Promise<{ type: "timeout" }>(resolve => {
      bgHandle = setTimeout(() => resolve({ type: "timeout" }), BG_TIMEOUT_MS);
    }),
  ]);
  if (bgHandle) clearTimeout(bgHandle);

  if (bgResult.type === "timeout") {
    return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: null, backgrounded: true, pid: proc.pid };
  }

  // Normal exit — drain pipes with a short timeout in case a backgrounded child
  // inherited the fds (common with `cmd &` inside sh -c)
  await Promise.race([
    Promise.all([pumpStdout, pumpStderr]),
    new Promise<void>(r => setTimeout(r, 2000)),
  ]);
  return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: bgResult.code, backgrounded: false, pid: proc.pid };
}

/** Format a ShellResult into the string the Bash tool returns to the LLM. */
export function formatShellResult(r: ShellResult): string {
  if (r.backgrounded) {
    const lastLines = r.stdout.split("\n").slice(-50).join("\n");
    let output = `Process not finishing after 60 seconds, moving to background. PID: ${r.pid}`;
    if (lastLines.trim()) output += `\nLast stdout (last 50 lines):\n${lastLines}`;
    if (r.stderr.trim()) {
      output += `\nLast stderr:\n${r.stderr.split("\n").slice(-10).join("\n")}`;
    }
    return output;
  }

  let result = "";
  if (r.stdout) result += r.stdout;
  if (r.stderr) result += (result ? "\n" : "") + `stderr: ${r.stderr}`;
  if (r.exitCode !== 0 && r.exitCode !== null) result += `\nexit code: ${r.exitCode}`;
  return result || "(no output)";
}
