import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { exec, killProcessTree, readBounded, formatBackgrounded } from "../../bin/shell.ts";
import { trackedChildCount, killTrackedChildren } from "../core/children.ts";
import { ToolRegistry } from "./registry.ts";
import { registerBuiltins } from "./builtins.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll until `pid` is gone (killProcessTree escalates after 250ms). */
async function waitGone(pid: number, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

describe("exec", () => {
  test("captures stdout, stderr and the real exit code", async () => {
    const r = await exec({ command: "echo out; echo err >&2; exit 3" });
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
    expect(r.exitCode).toBe(3);
    expect(r.backgrounded).toBe(false);
  });

  test("`cmd &` inside the shell does not hold the call open", async () => {
    const start = Date.now();
    const r = await exec({ command: "sleep 3 & echo started" });
    expect(r.stdout).toBe("started\n");
    expect(Date.now() - start).toBeLessThan(1500);
  });

  test("timeout kills the process tree and keeps partial output", async () => {
    const r = await exec({ command: "echo partial; sleep 5 & sleep 5", timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(r.stdout).toBe("partial\n");
    expect(await waitGone(r.pid)).toBe(true);
  });

  test("abort kills the process tree and returns partial output", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const start = Date.now();
    const r = await exec({ command: "echo before; sleep 10", signal: ac.signal });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBe(130);
    expect(r.stdout).toBe("before\n");
    expect(await waitGone(r.pid)).toBe(true);
  });

  test("a command still running after bgTimeoutMs is backgrounded, not killed, and untracked", async () => {
    const r = await exec({ command: "echo hello; sleep 5", bgTimeoutMs: 150 });
    try {
      expect(r.backgrounded).toBe(true);
      expect(r.exitCode).toBeNull();
      expect(r.stdout).toBe("hello");
      expect(alive(r.pid)).toBe(true);
      // Intentionally backgrounded processes are not killed on shutdown.
      expect(trackedChildCount()).toBe(0);
      expect(existsSync(r.logFiles!.stdout)).toBe(true);
    } finally {
      killProcessTree(r.pid);
      if (r.logFiles) rmSync(dirname(r.logFiles.stdout), { recursive: true, force: true });
    }
  });

  test("in-flight commands are tracked so shutdown can kill them", async () => {
    const pending = exec({ command: "sleep 10" });
    await Bun.sleep(50);
    expect(trackedChildCount()).toBe(1);
    expect(killTrackedChildren()).toBe(1);
    const r = await pending;
    expect(r.exitCode).not.toBe(0);
    expect(trackedChildCount()).toBe(0);
  });
});

describe("readBounded", () => {
  test("keeps head and tail of large output", async () => {
    const path = join(tmpdir(), `gloop-bounded-${Date.now()}.txt`);
    await Bun.write(path, "A".repeat(1000) + "B".repeat(1000));
    const text = await readBounded(path, 200);
    expect(text.startsWith("A".repeat(100))).toBe(true);
    expect(text.endsWith("B".repeat(100))).toBe(true);
    expect(text).toContain("[… 1800 bytes omitted …]");
  });

  test("exec bounds what it reads back", async () => {
    const r = await exec({ command: "head -c 100000 /dev/zero | tr '\\0' x", maxOutputBytes: 1000 });
    expect(r.stdout.length).toBeLessThan(1100);
    expect(r.stdout).toContain("bytes omitted");
  });
});

describe("Bash tool: background handling", () => {
  test("the model sees the PID and last output, not a failure", async () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, { bashBackgroundAfterMs: 150 });
    const output = await registry.get("Bash")!.execute({ command: "echo serving; sleep 5" });
    const pid = Number(/PID (\d+)/.exec(output)?.[1]);
    try {
      expect(output).toContain("Still running in the background");
      expect(output).toContain("serving");
      expect(output).not.toContain("exit code");
      expect(alive(pid)).toBe(true);
    } finally {
      killProcessTree(pid);
      const logDir = /to (\S+)\/stdout\.log/.exec(output)?.[1];
      if (logDir) rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("the tool's signal kills the command", async () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const start = Date.now();
    const output = await registry.get("Bash")!.execute({ command: "sleep 10" }, { signal: ac.signal });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(output).toContain("exit code 130");
  });

  test("formatBackgrounded reports the configured wait", () => {
    const text = formatBackgrounded({
      stdout: "", stderr: "", exitCode: null, backgrounded: true, timedOut: false, aborted: false,
      pid: 42, backgroundAfterMs: 5000,
    });
    expect(text).toContain("after 5s (PID 42)");
    expect(text).toContain("kill -- -42");
  });
});
