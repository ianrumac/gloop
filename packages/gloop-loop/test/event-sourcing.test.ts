/**
 * Event sourcing end-to-end — the property that matters:
 *
 *     projectState(agent.log).history  ===  agent.convo.getHistory()
 *
 * …after every kind of turn the interpreter can run.  Plus resume from a
 * store (clean stop and simulated crash), and the causal graph.
 */

import { test, expect, describe } from "bun:test";
import { AgentLoop } from "../src/agent.js";
import { MemoryEventStore, EventLog } from "../src/log.js";
import { projectState } from "../src/state.js";
import type { LogEvent } from "../src/events.js";
import { ScriptedProvider, tc, tcNoId, echoTool, completeTool, flush } from "./mock-provider.js";

function expectReplayMatches(agent: AgentLoop): void {
  const state = agent.snapshot();
  expect(state.history).toEqual(agent.convo.getHistory());
  expect(state.system).toEqual(agent.convo.getSystem());
}

describe("replay equivalence — snapshot() rebuilds the live conversation", () => {
  test("text-only turn", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([{ text: "hello there, this is a longer reply" }]),
      model: "m", system: "sys", tools: [],
    });
    await agent.sendSync("hi");
    expectReplayMatches(agent);
    expect(agent.snapshot().history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there, this is a longer reply" },
    ]);
    await agent.stop();
  });

  test("native tool calls (assistant toolCalls + role:tool responses)", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([
        { text: "let me look", toolCalls: [tc("c1", "Echo", { text: "a" }), tc("c2", "Echo", { text: "b" })] },
        { text: "done", toolCalls: [tc("c3", "CompleteTask", { summary: "ok" })] },
      ]),
      model: "m", tools: [echoTool, completeTool],
    });
    await agent.sendSync("go");
    expectReplayMatches(agent);
    const h = agent.convo.getHistory();
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(h[1]!.toolCalls).toHaveLength(2);
    expect(h[2]).toEqual({ role: "tool", toolCallId: "c1", content: "echo:a" });
    await agent.stop();
  });

  test("tool calls without provider ids (legacy synthetic-user path)", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([
        { text: "", toolCalls: [tcNoId("Echo", { text: "x" })] },
        { text: "final" },
      ]),
      model: "m", tools: [echoTool, completeTool],
    });
    await agent.sendSync("go");
    expectReplayMatches(agent);
    const h = agent.convo.getHistory();
    expect(h[1]!.role).toBe("user");
    expect(h[1]!.content).toContain("<tool_result");
    await agent.stop();
  });

  test("failing tool + denied confirmation still replay exactly", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([
        { toolCalls: [tc("c1", "Boom", {}), tc("c2", "Danger", {})] },
        { text: "gave up" },
      ]),
      model: "m",
      confirm: async () => false,
      tools: [
        { name: "Boom", description: "", arguments: [], execute: async () => { throw new Error("kaboom"); } },
        { name: "Danger", description: "", arguments: [], askPermission: () => "sure?", execute: async () => "no" },
      ],
    });
    await agent.sendSync("go");
    expectReplayMatches(agent);
    const types = agent.log.events().map((e) => e.type);
    expect(types).toContain("confirm_request");
    expect(types).toContain("confirm_response");
    await agent.stop();
  });

  test("system message turn, setSystem, clear, setHistory", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([{ text: "a" }, { text: "b" }]),
      model: "m", system: "v1", tools: [],
    });
    await agent.sendSync("one");
    await agent.sendSync({ role: "system", content: "v2" });
    expectReplayMatches(agent);
    expect(agent.snapshot().system).toBe("v2");

    agent.setSystem("v3");
    agent.clear();
    expectReplayMatches(agent);
    expect(agent.snapshot().history).toEqual([]);

    agent.setHistory([{ role: "user", content: "seeded" }], "test");
    await agent.sendSync("two");
    expectReplayMatches(agent);
    expect(agent.snapshot().history[0]).toEqual({ role: "user", content: "seeded" });
    await agent.stop();
  });

  test("interrupted mid-stream keeps the partial assistant text", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([{ text: "0123456789ABCDEFGHIJKLMNOPQRS", delayMs: 5 }]),
      model: "m", tools: [],
    });
    const pending = agent.sendSync("go");
    await agent.nextEvent("stream_chunk");
    agent.interrupt();
    await expect(pending).rejects.toThrow("Interrupted");
    expectReplayMatches(agent);
    const partial = agent.log.events().find((e) => e.type === "assistant_message") as LogEvent<"assistant_message">;
    expect(partial.partial).toBe(true);
    expect(agent.snapshot().turns[0]!.status).toBe("interrupted");
    await agent.stop();
  });

  test("error turn: user message recorded, turn marked error", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([{ failBefore: new Error("provider down") }]),
      model: "m", tools: [],
    });
    await expect(agent.sendSync("go")).rejects.toThrow("provider down");
    expectReplayMatches(agent);
    const s = agent.snapshot();
    expect(s.turns[0]!.status).toBe("error");
    expect(s.history).toEqual([{ role: "user", content: "go" }]);
    expect(agent.log.events().some((e) => e.type === "llm_error")).toBe(true);
    await agent.stop();
  });

  test("memory ops and tools_changed are projected", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([
        { toolCalls: [tc("c1", "Remember", { content: "user likes cats" })] },
        { text: "noted" },
      ]),
      model: "m", tools: [echoTool, completeTool],
    });
    agent.addTool({ name: "Remember", description: "", arguments: [{ name: "content", description: "" }], execute: async () => "" });
    await agent.sendSync("go");
    const s = agent.snapshot();
    expect(s.memory).toEqual(["user likes cats"]);
    expect(s.tools).toEqual(["Echo", "CompleteTask", "Remember"]);
    expectReplayMatches(agent);
    await agent.stop();
  });
});

describe("resume from a store", () => {
  test("clean stop → resume: same history, next turn sees prior context", async () => {
    const store = new MemoryEventStore();
    const first = new AgentLoop({
      provider: new ScriptedProvider([{ text: "first reply" }]),
      model: "m", system: "sys", tools: [], store,
    });
    await first.sendSync("first question");
    await first.stop();

    const provider = new ScriptedProvider([{ text: "second reply" }]);
    const second = await AgentLoop.resume({ provider, model: "m", system: "sys", tools: [], store });
    expect(second.convo.getHistory()).toEqual(first.convo.getHistory());
    expect(second.pending()).toBe(0);

    await second.sendSync("second question");
    const sent = provider.calls[0]!.messages.map((m) => m.content);
    expect(sent).toEqual(["sys", "first question", "first reply", "second question"]);
    expect(second.snapshot().turns).toHaveLength(2);
    expectReplayMatches(second);
    await second.stop();
    // Both runs are in the one store, seq continuous.
    const seqs = store.load().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("crash mid-turn → resume rolls back to the last turn boundary and re-queues", async () => {
    const store = new MemoryEventStore();
    const agent = new AgentLoop({
      provider: new ScriptedProvider([
        { text: "reply one" },
        { text: "reply two", toolCalls: [tc("c1", "Echo", { text: "x" })] },
        { text: "reply three" },
      ]),
      model: "m", tools: [echoTool, completeTool], store,
    });
    await agent.sendSync("q1");
    agent.send("q2");            // msg_2 — runs the tool-call script
    await agent.sendSync("q3");  // msg_3 — queued behind q2 at "crash" time
    await agent.stop();

    // Simulate the process dying right after q2's tool ran but before its
    // turn_end (so q3 never got a turn_start in the surviving log).
    const all = store.load();
    const cut = all.findIndex((e) => e.turn === "msg_2" && e.type === "tool_done");
    const truncated = new MemoryEventStore(all.slice(0, cut + 1));

    const provider = new ScriptedProvider([{ text: "replayed two" }, { text: "replayed three" }]);
    const resumed = await AgentLoop.resume({ provider, model: "m", tools: [echoTool, completeTool], store: truncated });

    // History is exactly what q1 left behind.
    expect(resumed.convo.getHistory()).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "reply one" },
    ]);
    // q2 (cut off) and q3 (never started) are back in the inbox, in order.
    expect(resumed.pending()).toBe(2);
    const restored = resumed.log.events().find((e) => e.type === "restored") as LogEvent<"restored">;
    expect(restored.requeued).toBe(2);
    expect(restored.turns).toBe(1);
    // The projection agrees with the rollback and records the abandoned turn.
    expectReplayMatches(resumed);
    const afterRestore = resumed.snapshot();
    expect(afterRestore.turns.map((t) => t.status)).toEqual(["ok", "abandoned"]);
    expect(afterRestore.inbox.map((m) => m.content)).toEqual(["q2", "q3"]);

    resumed.start();
    await resumed.awaitIdle();
    const h = resumed.convo.getHistory().map((m) => m.content);
    expect(h).toEqual(["q1", "reply one", "q2", "replayed two", "q3", "replayed three"]);
    expectReplayMatches(resumed);
    await resumed.stop();
  });

  test("hydrate with history: 'latest' keeps the cut-off turn's writes", async () => {
    const store = new MemoryEventStore();
    const agent = new AgentLoop({ provider: new ScriptedProvider([{ text: "r" }]), model: "m", tools: [], store });
    await agent.sendSync("q");
    await agent.stop();
    const all = store.load();
    const cut = all.findIndex((e) => e.type === "assistant_message");
    const truncated = new MemoryEventStore(all.slice(0, cut + 1));
    const resumed = await AgentLoop.resume({
      provider: new ScriptedProvider([]), model: "m", tools: [], store: truncated, history: "latest", requeue: false,
    });
    expect(resumed.convo.getHistory()).toEqual([{ role: "user", content: "q" }, { role: "assistant", content: "r" }]);
    expect(resumed.pending()).toBe(0);
    await resumed.stop();
  });

  test("resumed message ids never collide with replayed ones", async () => {
    const store = new MemoryEventStore();
    const a = new AgentLoop({ provider: new ScriptedProvider([{ text: "1" }, { text: "2" }]), model: "m", tools: [], store });
    await a.sendSync("x");
    await a.sendSync("y");
    await a.stop();
    const b = await AgentLoop.resume({ provider: new ScriptedProvider([{ text: "3" }]), model: "m", tools: [], store });
    const ids: string[] = [];
    b.on("turn_start", (e) => ids.push(e.message.id!));
    await b.sendSync("z");
    expect(ids).toEqual(["msg_3"]);
    await b.stop();
  });
});

describe("event graph", () => {
  test("turn events form a causal chain with explicit pairs", async () => {
    const agent = new AgentLoop({
      provider: new ScriptedProvider([
        { text: "look", toolCalls: [tc("c1", "Echo", { text: "x" })] },
        { text: "done" },
      ]),
      model: "m", tools: [echoTool, completeTool],
    });
    await agent.sendSync("go");
    const log = agent.log;
    const by = (type: string) => log.events().filter((e) => e.type === type);

    const queued = by("message_queued")[0]!;
    const start = by("turn_start")[0]!;
    expect(start.parent).toBe(queued.eventId);
    expect(start.turn).toBe("msg_1");
    expect(queued.turn).toBeNull();

    const [req1] = by("llm_request");
    const [resp1] = by("llm_response");
    expect(resp1!.parent).toBe(req1!.eventId);
    expect(by("stream_chunk")[0]!.parent).toBe(req1!.eventId);

    const tStart = by("tool_start")[0]!;
    const tDone = by("tool_done")[0]!;
    expect(tDone.parent).toBe(tStart.eventId);
    expect((tStart as LogEvent<"tool_start">).args).toEqual({ text: "x" });
    expect((tStart as LogEvent<"tool_start">).callId).toBe("c1");

    // Everything in the turn descends from turn_start.
    const end = by("turn_end")[0]!;
    const roots = log.ancestors(end.eventId);
    expect(roots[roots.length - 1]!.type).toBe("message_queued");
    for (const e of log.events()) {
      if (e.turn === "msg_1" && e.type !== "turn_start") expect(e.parent).toBeDefined();
    }
    await agent.stop();
  });

  test("a shared EventLog interleaves two agents; each only dispatches its own", async () => {
    const shared = new EventLog();
    const a = new AgentLoop({ id: "a", eventLog: shared, provider: new ScriptedProvider([{ text: "A" }]), model: "m", tools: [] });
    const b = new AgentLoop({ id: "b", eventLog: shared, provider: new ScriptedProvider([{ text: "B" }]), model: "m", tools: [] });
    const seenByA: string[] = [];
    a.onEvent((e) => seenByA.push(e.agent));
    await Promise.all([a.sendSync("1"), b.sendSync("2")]);
    expect(new Set(seenByA)).toEqual(new Set(["a"]));
    expect(new Set(shared.events().map((e) => e.agent))).toEqual(new Set(["a", "b"]));
    expect(projectState(shared.events(), "b").history).toEqual(b.convo.getHistory());
    await a.stop(); await b.stop();
  });
});

describe("durability", () => {
  test("sendSync resolves only after the turn's events are in the store", async () => {
    let persisted = 0;
    const store = {
      append: async () => { await flush(); persisted += 1; },
      load: () => [],
    };
    const agent = new AgentLoop({ provider: new ScriptedProvider([{ text: "r" }]), model: "m", tools: [], store });
    await agent.sendSync("q");
    const inMemory = agent.log.size;
    // Everything up to and including turn_end has been written.
    expect(persisted).toBeGreaterThanOrEqual(inMemory - 1);
    await agent.stop();
    expect(persisted).toBe(agent.log.size);
  });
});
