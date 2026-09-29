/**
 * The context graph and the swappable trim strategy: graph in, trimmed
 * graph out, history replaced from the result.
 */

import { test, expect, describe } from "bun:test";
import { AgentLoop } from "../src/agent.js";
import { EventLog } from "../src/log.js";
import { projectState } from "../src/state.js";
import { projectGraph } from "../src/graph.js";
import {
  closeToolGroups,
  contextFromHistory,
  contextGraph,
  contextNode,
  keepLastTurns,
  projectContext,
  trimContext,
  type ContextGraph,
  type ContextStrategy,
  type ContextStrategyContext,
} from "../src/context.js";
import type { Message } from "../src/ai/types.js";
import { ScriptedProvider, tc, echoTool, completeTool } from "./mock-provider.js";

const manageContextTool = {
  name: "ManageContext",
  description: "prune",
  arguments: [{ name: "instructions", description: "i" }],
  execute: async () => "",
};

/** Two turns: the first echoes once, the second calls ManageContext. */
async function twoTurnAgent(contextStrategy: ContextStrategy) {
  const agent = new AgentLoop({
    id: "main",
    model: "m",
    tools: [echoTool, completeTool, manageContextTool],
    provider: new ScriptedProvider([
      { toolCalls: [tc("c1", "Echo", { text: "one" })] },
      { text: "first done" },
      { toolCalls: [tc("c2", "ManageContext", { instructions: "drop the old turn" })] },
      { text: "second done" },
    ]),
    contextStrategy,
  });
  await agent.sendSync("first");
  await agent.sendSync("second");
  await agent.stop();
  return agent;
}

describe("projectContext", () => {
  test("nodes are the live history, each tied to its event and turn; edges pair tool calls with results", async () => {
    const agent = await twoTurnAgent((g) => g);
    const graph = projectContext(agent.log.events(), "main");

    expect(graph.nodes.map((n) => n.message)).toEqual(projectState(agent.log.events(), "main").history);
    const turns = projectGraph(agent.log.events()).nodes.map((n) => n.turn);
    for (const node of graph.nodes) {
      expect(turns).toContain(node.turn!);
      expect(agent.log.get(node.eventId!)).toBeDefined();
    }

    const caller = graph.nodes.find((n) => n.message.toolCalls?.some((c) => c.id === "c1"))!;
    const answer = graph.nodes.find((n) => n.message.toolCallId === "c1")!;
    // Provenance stays with the assistant_message even though the calls were attached later.
    expect(agent.log.get(caller.eventId!)!.type).toBe("assistant_message");
    expect(graph.edges).toContainEqual({ from: caller.id, to: answer.id, kind: "tool_result", toolCallId: "c1" });
  });

  test("provenance survives a history_replaced; new messages belong to the replacing event", async () => {
    const agent = await twoTurnAgent((g) =>
      contextGraph(g.agent, [contextNode({ role: "user", content: "summary" }), ...g.nodes.slice(-2)]),
    );
    const replaced = agent.log.events().find((e) => e.type === "history_replaced")!;
    const graph = projectContext(agent.log.events(), "main");

    const summary = graph.nodes.find((n) => n.message.content === "summary")!;
    expect(summary.eventId).toBe(replaced.eventId);
    const survivor = graph.nodes.find((n) => n.message.content === "second")!;
    expect(agent.log.get(survivor.eventId!)!.type).toBe("user_message");
  });

  test("a live history the log does not know about still projects", () => {
    const graph = projectContext([], "main", [{ role: "user", content: "x" }]);
    expect(graph.nodes).toEqual([{ id: "live#0", message: { role: "user", content: "x" }, turn: null }]);
  });
});

describe("contextStrategy", () => {
  test("receives the graph and its context; the returned graph becomes the history", async () => {
    let seen: { graph: ContextGraph; ctx: ContextStrategyContext } | undefined;
    const agent = await twoTurnAgent((graph, ctx) => {
      seen = { graph, ctx };
      const current = graph.nodes[graph.nodes.length - 1]!.turn;
      return contextGraph(graph.agent, graph.nodes.filter((n) => n.turn === current));
    });

    expect(seen!.ctx).toMatchObject({ agent: "main", trigger: "tool", instructions: "drop the old turn", model: "m" });
    expect(seen!.ctx.eventLog).toBe(agent.log);
    expect(seen!.ctx.events.length).toBeGreaterThan(0);
    expect(new Set(seen!.graph.nodes.map((n) => n.turn)).size).toBe(2);

    const replaced = agent.log.events().find((e) => e.type === "history_replaced")!;
    expect(replaced).toMatchObject({ reason: "context_pruned:4" });
    const history = agent.convo.getHistory();
    expect(history[0]).toEqual({ role: "user", content: "second" });
    expect(history.some((m) => m.content === "first")).toBe(false);
    // The log replays to exactly what the conversation holds.
    expect(projectState(agent.log.events(), "main").history).toEqual(history);

    const done = agent.log.events().find((e) => e.type === "tool_done" && e.name === "ManageContext")!;
    expect(done).toMatchObject({ output: expect.stringContaining("removed 4 messages") });
  });

  test("an unchanged graph replaces nothing", async () => {
    const agent = await twoTurnAgent((g) => g);
    expect(agent.log.events().some((e) => e.type === "history_replaced")).toBe(false);
    const done = agent.log.events().find((e) => e.type === "tool_done" && e.name === "ManageContext")!;
    expect(done).toMatchObject({ output: expect.stringContaining("no messages pruned") });
  });

  test("contextPruneInterval runs the strategy with trigger \"auto\"", async () => {
    const triggers: string[] = [];
    const agent = new AgentLoop({
      model: "m",
      tools: [echoTool, completeTool],
      provider: new ScriptedProvider([
        { toolCalls: [tc("c1", "Echo", { text: "1" })] },
        { text: "done" },
      ]),
      contextPruneInterval: 1,
      contextStrategy: (g, ctx) => { triggers.push(ctx.trigger); return g; },
    });
    await agent.sendSync("go");
    await agent.stop();
    expect(triggers).toEqual(["auto"]);
  });

  test("keepLastTurns drops whole older turns without asking a model", async () => {
    const agent = await twoTurnAgent(keepLastTurns(1));
    const contents = agent.convo.getHistory().map((m) => m.content);
    expect(contents).not.toContain("first");
    expect(contents).toContain("second");
  });

  test("the default strategy still forks into the shared log as `${id}/context`", async () => {
    const shared = new EventLog();
    const agent = new AgentLoop({
      id: "main", eventLog: shared, model: "m",
      tools: [completeTool, manageContextTool],
      provider: new ScriptedProvider([
        { toolCalls: [tc("c1", "ManageContext", { instructions: "prune" })] },
        // The fork's turn: delete #0, finish.
        { toolCalls: [tc("d1", "DeleteMessages", { indexes: "0" })] },
        { toolCalls: [tc("f1", "CompleteTask", { summary: "pruned" })] },
        { text: "done" },
      ]),
    });
    await agent.sendSync("hello");
    await agent.stop();
    expect(new Set(shared.events().map((e) => e.agent))).toEqual(new Set(["main", "main/context"]));
  });
});

describe("trimContext", () => {
  const history: Message[] = [
    { role: "user", content: "read it" },
    { role: "assistant", content: "", toolCalls: [tc("c1", "ReadFile", { path: "a" }), tc("c2", "ReadFile", { path: "b" })] },
    { role: "tool", toolCallId: "c1", content: "A" },
    { role: "tool", toolCallId: "c2", content: "B" },
    { role: "assistant", content: "read both" },
  ];
  const ctx = { agent: "agent", instructions: "", trigger: "tool", events: [], provider: new ScriptedProvider([]), model: "m" } as const;

  test("a partly kept tool-call group is dropped as a unit", async () => {
    const graph = contextFromHistory(history);
    const trim = await trimContext((g) => contextGraph(g.agent, g.nodes.filter((n) => n.message.content !== "A")), graph, ctx);
    expect(trim.history.map((m) => m.content)).toEqual(["read it", "read both"]);
    expect(trim.removed).toBe(3);
    expect(closeToolGroups(graph, graph.nodes)).toEqual(graph.nodes);
  });

  test("counts added nodes and reports rewrites as a change", async () => {
    const graph = contextFromHistory(history);
    const added = await trimContext((g) => contextGraph(g.agent, [...g.nodes, contextNode({ role: "user", content: "note" })]), graph, ctx);
    expect(added).toMatchObject({ added: 1, removed: 0, changed: true });

    const rewritten = await trimContext(
      (g) => contextGraph(g.agent, g.nodes.map((n) => (n.message.content === "B" ? { ...n, message: { ...n.message, content: "[elided]" } } : n))),
      graph, ctx,
    );
    expect(rewritten).toMatchObject({ added: 0, removed: 0, changed: true });
    expect(rewritten.history[3]!.content).toBe("[elided]");
  });

  test("rejects a strategy that does not return a graph", async () => {
    const graph = contextFromHistory(history);
    await expect(trimContext((() => undefined) as unknown as ContextStrategy, graph, ctx)).rejects.toThrow("ContextGraph");
  });
});
