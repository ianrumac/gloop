/**
 * Retry — the `withRetry` helper and its integration at the LLM and tool
 * boundaries, including the "never retry after output was streamed" rule.
 */

import { test, expect, describe } from "bun:test";
import { withRetry, backoffDelay } from "../src/retry.js";
import { AbortError } from "../src/core/abort.js";
import { AgentLoop } from "../src/agent.js";
import type { LogEvent } from "../src/events.js";
import { ScriptedProvider, tc, completeTool } from "./mock-provider.js";

const noSleep = async () => {};

describe("withRetry", () => {
  test("returns on first success without calling onRetry", async () => {
    const retries: number[] = [];
    const r = await withRetry({ attempts: 3 }, async () => "ok", { onRetry: (i) => retries.push(i.attempt), sleep: noSleep });
    expect(r).toBe("ok");
    expect(retries).toEqual([]);
  });

  test("retries up to attempts with doubling backoff, then rethrows the last error", async () => {
    const delays: number[] = [];
    let n = 0;
    await expect(
      withRetry({ attempts: 3, backoffMs: 100 }, async () => { throw new Error(`fail ${++n}`); }, {
        onRetry: (i) => delays.push(i.delayMs), sleep: noSleep,
      }),
    ).rejects.toThrow("fail 3");
    expect(delays).toEqual([100, 200]);
  });

  test("backoff is capped by maxBackoffMs", () => {
    expect(backoffDelay({ attempts: 9, backoffMs: 1000, maxBackoffMs: 2500 }, 5)).toBe(2500);
    expect(backoffDelay({ attempts: 9 }, 1)).toBe(250);
  });

  test("retryIf=false and AbortError surface immediately; undefined policy never retries", async () => {
    let calls = 0;
    await expect(withRetry({ attempts: 5, retryIf: () => false }, async () => { calls++; throw new Error("x"); }, { sleep: noSleep })).rejects.toThrow("x");
    expect(calls).toBe(1);
    calls = 0;
    await expect(withRetry({ attempts: 5 }, async () => { calls++; throw new AbortError(); }, { sleep: noSleep })).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(1);
    calls = 0;
    await expect(withRetry(undefined, async () => { calls++; throw new Error("x"); }, { sleep: noSleep })).rejects.toThrow("x");
    expect(calls).toBe(1);
  });

  test("an abort during backoff rejects with AbortError", async () => {
    const ac = new AbortController();
    const p = withRetry({ attempts: 3, backoffMs: 50 }, async () => { throw new Error("x"); }, {
      signal: ac.signal,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });
});

describe("LLM retry in AgentLoop", () => {
  test("a call that fails before streaming is retried and logged", async () => {
    const provider = new ScriptedProvider([
      { failBefore: new Error("503 overloaded") },
      { failBefore: new Error("503 again") },
      { text: "third time lucky" },
    ]);
    const agent = new AgentLoop({ provider, model: "m", tools: [], retry: { llm: { attempts: 3, backoffMs: 1 } } });
    await agent.sendSync("go");
    const retries = agent.log.events().filter((e) => e.type === "retry") as LogEvent<"retry">[];
    expect(retries.map((r) => [r.boundary, r.attempt, r.error.message])).toEqual([
      ["llm", 1, "503 overloaded"],
      ["llm", 2, "503 again"],
    ]);
    expect(agent.log.events().filter((e) => e.type === "llm_error")).toHaveLength(2);
    expect(agent.log.events().filter((e) => e.type === "llm_request")).toHaveLength(1);
    expect(agent.convo.getHistory().at(-1)!.content).toBe("third time lucky");
    expect(agent.snapshot().turns[0]!.status).toBe("ok");
    await agent.stop();
  });

  test("no retry once text has been streamed (would duplicate output)", async () => {
    const provider = new ScriptedProvider([
      { text: "0123456789ABCDEF", failAfterChunks: 1 },
      { text: "should not be used" },
    ]);
    const agent = new AgentLoop({ provider, model: "m", tools: [], retry: { llm: { attempts: 3, backoffMs: 1 } } });
    await expect(agent.sendSync("go")).rejects.toThrow("stream failed after 1 chunks");
    expect(agent.log.events().filter((e) => e.type === "retry")).toHaveLength(0);
    expect(provider.calls).toHaveLength(1);
    await agent.stop();
  });

  test("without a policy a failure surfaces on the first attempt", async () => {
    const provider = new ScriptedProvider([{ failBefore: new Error("nope") }, { text: "x" }]);
    const agent = new AgentLoop({ provider, model: "m", tools: [] });
    await expect(agent.sendSync("go")).rejects.toThrow("nope");
    expect(provider.calls).toHaveLength(1);
    await agent.stop();
  });
});

describe("tool retry in AgentLoop", () => {
  function flakyTool(name: string, retryable: boolean, failures: number) {
    let n = 0;
    return {
      name, description: "", arguments: [], retryable,
      execute: async () => { if (n++ < failures) throw new Error(`${name} flaked ${n}`); return `${name} ok`; },
      attempts: () => n,
    };
  }

  test("retryable tools are retried; non-retryable are not", async () => {
    const good = flakyTool("Good", true, 2);
    const bad = flakyTool("Bad", false, 2);
    const agent = new AgentLoop({
      provider: new ScriptedProvider([
        { toolCalls: [tc("c1", "Good", {}), tc("c2", "Bad", {})] },
        { text: "done" },
      ]),
      model: "m", tools: [good, bad, completeTool],
      retry: { tool: { attempts: 3, backoffMs: 1 } },
    });
    await agent.sendSync("go");
    expect(good.attempts()).toBe(3);
    expect(bad.attempts()).toBe(1);
    const dones = agent.log.events().filter((e) => e.type === "tool_done") as LogEvent<"tool_done">[];
    expect(dones.map((d) => [d.name, d.ok])).toEqual([["Good", true], ["Bad", false]]);
    const retries = agent.log.events().filter((e) => e.type === "retry") as LogEvent<"retry">[];
    expect(retries.map((r) => [r.boundary, r.name, r.attempt])).toEqual([["tool", "Good", 1], ["tool", "Good", 2]]);
    const toolMsgs = agent.convo.getHistory().filter((m) => m.role === "tool");
    expect(toolMsgs[0]!.content).toBe("Good ok");
    expect(toolMsgs[1]!.content).toContain("Error: Bad flaked 1");
    await agent.stop();
  });
});
