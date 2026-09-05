/**
 * Hooks — attach / detach, isolation of failures, filtering, and wiring two
 * agents together through the log with `bridgeAgents`.
 */

import { test, expect, describe } from "bun:test";
import { AgentLoop } from "../src/agent.js";
import { EventLog } from "../src/log.js";
import { bridgeAgents } from "../src/hooks.js";
import type { LogEvent } from "../src/events.js";
import { ScriptedProvider, tc, completeTool, flush } from "./mock-provider.js";

describe("attach", () => {
  test("hooks receive events; detach stops them; `types` filters", async () => {
    const agent = new AgentLoop({ provider: new ScriptedProvider([{ text: "a" }, { text: "b" }]), model: "m", tools: [] });
    const all: string[] = [];
    const only: string[] = [];
    const detach = agent.attach({ handle: (e) => { all.push(e.type); } });
    agent.attach({ types: ["turn_start", "turn_end"], handle: (e) => { only.push(e.type); } });

    await agent.sendSync("1");
    expect(all).toContain("llm_request");
    expect(only).toEqual(["turn_start", "turn_end"]);

    detach();
    const before = all.length;
    await agent.sendSync("2");
    expect(all.length).toBe(before);
    expect(only).toEqual(["turn_start", "turn_end", "turn_start", "turn_end"]);
    await agent.stop();
  });

  test("hooks passed in options are attached at construction", async () => {
    const seen: string[] = [];
    const agent = new AgentLoop({
      provider: new ScriptedProvider([{ text: "a" }]),
      model: "m", tools: [],
      hooks: [{ types: ["system_set", "tools_changed"], handle: (e) => { seen.push(e.type); } }],
      system: "s",
    });
    expect(seen).toEqual(["system_set", "tools_changed"]);
    await agent.stop();
  });

  test("a throwing hook becomes a hook_error and the turn still succeeds", async () => {
    const agent = new AgentLoop({ provider: new ScriptedProvider([{ text: "ok" }]), model: "m", tools: [] });
    agent.attach({
      name: "flaky",
      types: ["llm_request"],
      handle: () => { throw new Error("sync boom"); },
    });
    agent.attach({
      name: "flaky-async",
      types: ["llm_response"],
      handle: async () => { throw new Error("async boom"); },
    });
    await agent.sendSync("go");
    await flush();
    const errors = agent.log.events().filter((e) => e.type === "hook_error") as LogEvent<"hook_error">[];
    expect(errors.map((e) => e.hook).sort()).toEqual(["flaky", "flaky-async"]);
    expect(errors[0]!.error.message).toMatch(/boom/);
    expect(agent.snapshot().turns[0]!.status).toBe("ok");
    await agent.stop();
  });

  test("a hook that fails on hook_error does not cascade", async () => {
    const agent = new AgentLoop({ provider: new ScriptedProvider([{ text: "ok" }]), model: "m", tools: [] });
    agent.attach({ name: "bad", handle: () => { throw new Error("always"); } });
    await agent.sendSync("go");
    await flush();
    const errors = agent.log.events().filter((e) => e.type === "hook_error") as LogEvent<"hook_error">[];
    expect(errors.every((e) => e.eventType !== "hook_error")).toBe(true);
    expect(errors.length).toBeLessThan(agent.log.size);
    await agent.stop();
  });

  test("scope: 'all' sees every agent on a shared log", async () => {
    const shared = new EventLog();
    const a = new AgentLoop({ id: "a", eventLog: shared, provider: new ScriptedProvider([{ text: "A" }]), model: "m", tools: [] });
    const b = new AgentLoop({ id: "b", eventLog: shared, provider: new ScriptedProvider([{ text: "B" }]), model: "m", tools: [] });
    const agents = new Set<string>();
    a.attach({ scope: "all", handle: (e) => { agents.add(e.agent); } });
    await Promise.all([a.sendSync("1"), b.sendSync("2")]);
    expect(agents).toEqual(new Set(["a", "b"]));
    await a.stop(); await b.stop();
  });
});

describe("bridgeAgents", () => {
  test("coder → reviewer: task_complete becomes a message with a cross-agent cause", async () => {
    const shared = new EventLog();
    const coder = new AgentLoop({
      id: "coder", eventLog: shared, model: "m", tools: [completeTool],
      provider: new ScriptedProvider([{ toolCalls: [tc("c1", "CompleteTask", { summary: "wrote the parser" })] }]),
    });
    const reviewerProvider = new ScriptedProvider([{ text: "looks good" }]);
    const reviewer = new AgentLoop({ id: "reviewer", eventLog: shared, model: "m", tools: [], provider: reviewerProvider });

    bridgeAgents(coder, reviewer, { on: "task_complete", map: (e) => `Review: ${e.summary}` });
    reviewer.start();

    await coder.sendSync("build a parser");
    await reviewer.nextEvent("turn_end");

    expect(reviewerProvider.calls[0]!.messages.at(-1)!.content).toBe("Review: wrote the parser");

    const completeEvt = shared.events().find((e) => e.type === "task_complete")!;
    const queued = shared.events().find((e) => e.agent === "reviewer" && e.type === "message_queued") as LogEvent<"message_queued">;
    expect(queued.message.cause).toEqual({ agent: "coder", eventId: completeEvt.eventId });

    const reviewerTurn = shared.events().find((e) => e.agent === "reviewer" && e.type === "turn_start")!;
    expect(reviewerTurn.parent).toBe(queued.eventId);
    await coder.stop(); await reviewer.stop();
  });

  test("map returning null skips; multiple types; default map forwards the summary", async () => {
    const a = new AgentLoop({ id: "a", model: "m", tools: [completeTool],
      provider: new ScriptedProvider([
        { toolCalls: [tc("c1", "CompleteTask", { summary: "s" })] },
        { toolCalls: [tc("c2", "CompleteTask", { summary: "t" })] },
      ]) });
    const b = new AgentLoop({ id: "b", model: "m", tools: [], provider: new ScriptedProvider([]) });
    const detach = bridgeAgents(a, b, {
      on: ["task_complete", "turn_end"],
      map: (e) => (e.type === "turn_end" ? null : `got ${e.summary}`),
    });
    await a.sendSync("go");
    expect(b.pending()).toBe(1);
    expect((b.snapshot().inbox[0]!).content).toBe("got s");
    detach();

    const c = new AgentLoop({ id: "c", model: "m", tools: [], provider: new ScriptedProvider([]) });
    bridgeAgents(a, c, { on: "task_complete" });
    await a.sendSync("go again");
    expect(b.pending()).toBe(1);               // detached — unchanged
    expect(c.snapshot().inbox[0]!.content).toBe("t");   // default map = summary
    await a.stop(); await b.stop(); await c.stop();
  });
});
