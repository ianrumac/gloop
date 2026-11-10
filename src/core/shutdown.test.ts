import { describe, expect, test } from "bun:test";
import { createShutdown, EXIT_CODES } from "./shutdown.ts";

function harness(overrides: { stopAgent?: () => Promise<void>; stopTimeoutMs?: number } = {}) {
  const calls: string[] = [];
  const exits: number[] = [];
  let clock = 0;
  const shutdown = createShutdown({
    beforeStop: () => calls.push("ui"),
    stopAgent: overrides.stopAgent ?? (async () => { calls.push("stop"); }),
    killChildren: () => { calls.push("kill"); return 0; },
    afterStop: (reason, code) => { calls.push(`after:${reason}:${code}`); },
    exit: (code) => { calls.push(`exit:${code}`); exits.push(code); },
    stopTimeoutMs: overrides.stopTimeoutMs,
    now: () => clock,
  });
  return { shutdown, calls, exits, tick: (ms: number) => { clock += ms; } };
}

describe("createShutdown", () => {
  test("UI, agent, children, last words, exit — in that order", async () => {
    const h = harness();
    await h.shutdown.request("SIGTERM");
    expect(h.calls).toEqual(["ui", "stop", "kill", "after:SIGTERM:143", "exit:143"]);
  });

  test("conventional exit codes", () => {
    expect(EXIT_CODES).toEqual({ quit: 0, SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
  });

  test("a second request while stopping exits immediately", async () => {
    let release!: () => void;
    const h = harness({ stopAgent: () => new Promise<void>((r) => { release = r; }) });
    const first = h.shutdown.request("quit");
    expect(h.shutdown.inProgress).toBe(true);
    h.tick(1000);
    await h.shutdown.request("SIGINT");
    expect(h.exits).toEqual([130]);
    release();
    await first;
  });

  test("the same signal delivered twice at once (launcher + terminal) counts once", async () => {
    let release!: () => void;
    const h = harness({ stopAgent: () => new Promise<void>((r) => { release = r; }) });
    const first = h.shutdown.request("SIGINT");
    h.tick(10);
    await h.shutdown.request("SIGINT");
    expect(h.exits).toEqual([]);
    release();
    await first;
    expect(h.exits).toEqual([130]);
  });

  test("a hung agent.stop does not block exit", async () => {
    const h = harness({ stopAgent: () => new Promise<void>(() => {}), stopTimeoutMs: 20 });
    await h.shutdown.request("SIGHUP");
    expect(h.calls.slice(-3)).toEqual(["kill", "after:SIGHUP:129", "exit:129"]);
  });
});
