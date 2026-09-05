/**
 * The multi-agent graph — one event fanning out to two agents, and whether
 * the log alone can reconstruct who talked to whom and why.
 */

import { test, expect, describe } from "bun:test";
import { AgentLoop } from "../src/agent.js";
import { EventLog, MemoryEventStore } from "../src/log.js";
import { bridgeAgents, withCause } from "../src/hooks.js";
import { projectGraph, graphToMermaid } from "../src/graph.js";
import { projectState } from "../src/state.js";
import type { LogEvent } from "../src/events.js";
import { ScriptedProvider, tc, completeTool } from "./mock-provider.js";

/** Planner completes a task; a hook fans it out to a coder and a writer. */
async function fanOutScenario(useBridge: boolean) {
  const shared = new EventLog({ store: new MemoryEventStore() });
  const planner = new AgentLoop({
    id: "planner", eventLog: shared, model: "m", tools: [completeTool],
    provider: new ScriptedProvider([{ toolCalls: [tc("c1", "CompleteTask", { summary: "plan: build + document" })] }]),
  });
  const coder = new AgentLoop({ id: "coder", eventLog: shared, model: "m", tools: [], provider: new ScriptedProvider([{ text: "built" }]) });
  const writer = new AgentLoop({ id: "writer", eventLog: shared, model: "m", tools: [], provider: new ScriptedProvider([{ text: "documented" }]) });

  if (useBridge) {
    bridgeAgents(planner, coder, { on: "task_complete", map: (e) => `Build: ${e.summary}` });
    bridgeAgents(planner, writer, { on: "task_complete", map: (e) => `Document: ${e.summary}` });
  } else {
    // A plain hook: one send links explicitly, the other relies on the
    // ambient cause.  Both must produce the same edge.
    planner.attach({
      types: ["task_complete"],
      handle: (e) => {
        coder.send(`Build: ${e.summary}`, { cause: e });
        writer.send(`Document: ${e.summary}`);
      },
    });
  }
  coder.start();
  writer.start();

  await planner.sendSync("make a plan");
  await Promise.all([coder.awaitIdle(), writer.awaitIdle()]);
  await Promise.all([planner.stop(), coder.stop(), writer.stop()]);
  return { shared, planner, coder, writer };
}

describe("fan-out: one event → two agents", () => {
  for (const useBridge of [true, false]) {
    const how = useBridge ? "via bridgeAgents" : "via a plain hook (explicit + ambient cause)";

    test(`${how}: both messages carry the same cause`, async () => {
      const { shared } = await fanOutScenario(useBridge);
      const done = shared.events().find((e) => e.type === "task_complete")!;
      const queued = shared.events().filter((e) => e.type === "message_queued" && e.agent !== "planner") as LogEvent<"message_queued">[];
      expect(queued.map((q) => q.agent).sort()).toEqual(["coder", "writer"]);
      for (const q of queued) {
        expect(q.message.cause).toEqual({ agent: "planner", eventId: done.eventId });
      }
    });

    test(`${how}: children() of the planner's task_complete are the two messages`, async () => {
      const { shared } = await fanOutScenario(useBridge);
      const done = shared.events().find((e) => e.type === "task_complete")!;
      const kids = shared.children(done.eventId);
      expect(kids.filter((k) => k.type === "message_queued").map((k) => k.agent).sort()).toEqual(["coder", "writer"]);
    });

    test(`${how}: ancestors() from the writer's LLM call reach the user's original message`, async () => {
      const { shared } = await fanOutScenario(useBridge);
      const writerLlm = shared.events().find((e) => e.agent === "writer" && e.type === "llm_request")!;
      const chain = shared.ancestors(writerLlm.eventId);
      const agents = chain.map((e) => e.agent);
      expect(agents[0]).toBe("writer");
      expect(agents[agents.length - 1]).toBe("planner");
      const root = chain[chain.length - 1] as LogEvent<"message_queued">;
      expect(root.type).toBe("message_queued");
      expect(root.message.content).toBe("make a plan");
      // The hop across agents goes through the planner's task_complete.
      expect(chain.some((e) => e.type === "task_complete" && e.agent === "planner")).toBe(true);
    });

    test(`${how}: descendants() of the user's message span all three agents`, async () => {
      const { shared } = await fanOutScenario(useBridge);
      const root = shared.events().find((e) => e.type === "message_queued")!;
      const agents = new Set(shared.descendants(root.eventId).map((e) => e.agent));
      expect(agents).toEqual(new Set(["planner", "coder", "writer"]));
    });

    test(`${how}: projectGraph shows planner → coder and planner → writer`, async () => {
      const { shared } = await fanOutScenario(useBridge);
      const g = projectGraph(shared.events());
      expect(g.agents.sort()).toEqual(["coder", "planner", "writer"]);
      expect(g.nodes).toHaveLength(3);
      expect(g.roots).toEqual(["planner:msg_1"]);
      expect(g.edges.map((e) => [e.from, e.to, e.causeType]).sort()).toEqual([
        ["planner:msg_1", "coder:msg_1", "task_complete"],
        ["planner:msg_1", "writer:msg_1", "task_complete"],
      ]);
      expect(g.nodes.every((n) => n.status === "ok")).toBe(true);
      expect(g.nodes.find((n) => n.agent === "planner")!.summary).toBe("plan: build + document");
      const mermaid = graphToMermaid(g);
      expect(mermaid).toContain("planner_msg_1 -->|task_complete| coder_msg_1");
      expect(mermaid).toContain("planner_msg_1 -->|task_complete| writer_msg_1");
    });
  }

  test("the graph survives a round-trip through a store (no in-memory objects needed)", async () => {
    const { shared } = await fanOutScenario(true);
    await shared.flush();
    const reloaded = new EventLog({ store: new MemoryEventStore(shared.events()) });
    await reloaded.load();
    const g = projectGraph(reloaded.events());
    expect(g.edges).toHaveLength(2);
    expect(projectState(reloaded.events(), "coder").history.map((m) => m.content)).toEqual([
      "Build: plan: build + document", "built",
    ]);
  });

  test("fan-in: two agents' completions both reach one collector, edges distinct", async () => {
    const shared = new EventLog();
    const mk = (id: string, summary: string) => new AgentLoop({
      id, eventLog: shared, model: "m", tools: [completeTool],
      provider: new ScriptedProvider([{ toolCalls: [tc("c", "CompleteTask", { summary })] }]),
    });
    const a = mk("a", "A done"), b = mk("b", "B done");
    const collector = new AgentLoop({ id: "collector", eventLog: shared, model: "m", tools: [], provider: new ScriptedProvider([{ text: "1" }, { text: "2" }]) });
    bridgeAgents(a, collector, { on: "task_complete" });
    bridgeAgents(b, collector, { on: "task_complete" });
    collector.start();
    await Promise.all([a.sendSync("go"), b.sendSync("go")]);
    await collector.awaitIdle();
    await Promise.all([a.stop(), b.stop(), collector.stop()]);

    const g = projectGraph(shared.events());
    const into = g.edges.filter((e) => e.to.startsWith("collector:"));
    expect(into.map((e) => e.from).sort()).toEqual(["a:msg_1", "b:msg_1"]);
    expect(new Set(into.map((e) => e.to)).size).toBe(2); // two distinct collector turns
  });

  test("cause precedence: send option > message.cause > ambient > none", async () => {
    const shared = new EventLog();
    const x = new AgentLoop({ id: "x", eventLog: shared, model: "m", tools: [], provider: new ScriptedProvider([]) });
    withCause({ agent: "ext", eventId: "ambient" }, () => {
      x.send("ambient only");
      x.send({ role: "user", content: "on message", cause: { agent: "ext", eventId: "on-message" } });
      x.send({ role: "user", content: "option wins", cause: { agent: "ext", eventId: "on-message" } }, { cause: { agent: "ext", eventId: "option" } });
    });
    const some = shared.events()[0]!;
    x.send("log event as cause", { cause: some });
    x.send("none");
    const q = shared.events().filter((e) => e.type === "message_queued") as LogEvent<"message_queued">[];
    expect(q.map((e) => e.message.cause?.eventId)).toEqual(["ambient", "on-message", "option", some.eventId, undefined]);
    await x.stop();
  });

  test("history_replaced / history_cleared never remove events from the log", async () => {
    const agent = new AgentLoop({ provider: new ScriptedProvider([{ text: "reply" }]), model: "m", tools: [] });
    await agent.sendSync("hello");
    const before = agent.log.size;
    agent.clear();
    agent.setHistory([{ role: "user", content: "fresh" }], "test");
    expect(agent.log.size).toBe(before + 2);
    // The pruned conversation is still fully recoverable from the log.
    const types = agent.log.events().map((e) => e.type);
    expect(types).toContain("user_message");
    expect(types).toContain("assistant_message");
    expect(types).toContain("history_cleared");
    expect(types).toContain("history_replaced");
    expect(agent.snapshot().history).toEqual([{ role: "user", content: "fresh" }]);
    await agent.stop();
  });
});
