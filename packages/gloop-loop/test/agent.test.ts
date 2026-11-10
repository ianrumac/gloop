/**
 * AgentLoop construction / configuration tests.
 *
 * Runtime behaviour (send / sendSync, events, interrupt/stop, confirm_request,
 * ask_request, tool id matching) is covered by `actor.test.ts`.  This file
 * focuses on static configuration: registry wiring, tool overrides,
 * `clear()` / `addTool()` / `setSystem()`, and that loop-level options
 * (contextPruneInterval, classifySpawn) reach the underlying interpreter.
 */

import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  JsonToolCall,
} from "../src/ai/types.js";
import { AgentLoop, type AgentEvent } from "../src/agent.js";
import { ScriptedProvider, echoTool } from "./mock-provider.js";
import { contextGraph, type ContextStrategy } from "../src/context.js";

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

interface MockResponse {
  text?: string;
  toolCalls?: JsonToolCall[];
}

class MockProvider implements AIProvider {
  readonly name = "mock";
  private responses: MockResponse[];
  private callIndex = 0;
  calls: AIRequestConfig[] = [];

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    this.calls.push(config);
    const resp = this.responses[this.callIndex++] ?? {};
    return {
      id: "mock",
      model: "mock",
      content: resp.text ?? null,
      finishReason: resp.toolCalls?.length ? "tool_calls" : "stop",
      ...(resp.toolCalls && { toolCalls: resp.toolCalls }),
    };
  }

  stream(config: AIRequestConfig): StreamResult {
    this.calls.push(config);
    const resp = this.responses[this.callIndex++] ?? {};
    const text = resp.text ?? "";
    const textStream: AsyncIterableIterator<string> = (async function* () {
      for (let i = 0; i < text.length; i += 10) yield text.slice(i, i + 10);
    })();
    return {
      textStream,
      toolCalls: Promise.resolve(resp.toolCalls ?? []),
      finishReason: Promise.resolve(null),
      cancel: async () => {},
    };
  }
}

function tc(id: string, name: string, args: Record<string, string>): JsonToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/**
 * Drive the actor for a single turn via the public DX helpers and return
 * every event that fired during it.  Stops the actor on exit so each test
 * is self-contained.
 */
async function runOneTurn(agent: AgentLoop, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const listener = (e: AgentEvent) => events.push(e);
  agent.onEvent(listener);
  try {
    await agent.sendSync(input);
  } catch {
    // Tests that expect errors inspect the event list themselves.
  }
  agent.offEvent(listener);
  await agent.stop();
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentLoop (construction & config)", () => {
  test("constructor registers provided tools", () => {
    const provider = new MockProvider([]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [
        {
          name: "Custom",
          description: "A custom tool",
          arguments: [],
          execute: async () => "custom output",
        },
      ],
    });

    expect(agent.registry.has("Custom")).toBe(true);
    expect(agent.registry.names()).toEqual(["Custom"]);
  });

  test("constructor falls back to primitiveTools when tools is not provided", () => {
    const provider = new MockProvider([]);
    const mockIO = {
      readFile: async () => "content",
      fileExists: async () => true,
      writeFile: async () => {},
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      io: mockIO,
    });

    expect(agent.registry.has("ReadFile")).toBe(true);
    expect(agent.registry.has("Bash")).toBe(true);
    expect(agent.registry.has("CompleteTask")).toBe(true);
    expect(agent.registry.has("AskUser")).toBe(true);
  });

  test("clear() resets conversation history and tool call counter", async () => {
    const provider = new MockProvider([{ text: "First response" }]);
    const agent = new AgentLoop({ provider, model: "test-model", tools: [] });

    await runOneTurn(agent, "first");
    expect(agent.convo.getHistory().length).toBeGreaterThan(0);

    agent.clear();
    expect(agent.convo.getHistory()).toEqual([]);
    expect(agent.world.toolCalls).toBe(0);
  });

  test("clear() returns this for chaining", () => {
    const agent = new AgentLoop({
      provider: new MockProvider([]),
      model: "test-model",
      tools: [],
    });
    expect(agent.clear()).toBe(agent);
  });

  test("addTool() registers a new tool and returns this", () => {
    const agent = new AgentLoop({
      provider: new MockProvider([]),
      model: "test-model",
      tools: [],
    });

    expect(agent.registry.has("NewTool")).toBe(false);

    const result = agent.addTool({
      name: "NewTool",
      description: "A new tool",
      arguments: [],
      execute: async () => "new",
    });

    expect(agent.registry.has("NewTool")).toBe(true);
    expect(result).toBe(agent);
  });

  test("setSystem() updates the system prompt seen by the provider", async () => {
    const provider = new MockProvider([{ text: "response" }]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      system: "initial prompt",
      tools: [],
    });

    agent.setSystem("updated prompt");
    await runOneTurn(agent, "test");

    const messages = provider.calls[0]?.messages;
    const systemMsg = messages?.find((m) => m.role === "system");
    expect(systemMsg?.content).toBe("updated prompt");
  });

  test("constructor merges skills into the system prompt", async () => {
    const provider = new MockProvider([{ text: "ok" }]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      system: "base",
      tools: [],
      skills: [
        {
          name: "demo",
          description: "A demo skill",
          dir: "/tmp/demo",
          body: "body",
        },
      ],
    });

    await runOneTurn(agent, "hi");

    const messages = provider.calls[0]?.messages;
    const systemMsg = messages?.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("base");
    expect(systemMsg?.content).toContain("AVAILABLE SKILLS");
    expect(systemMsg?.content).toContain("/demo");
    expect(systemMsg?.content).toContain("A demo skill");
  });

  test("setSystem() returns this for chaining", () => {
    const agent = new AgentLoop({
      provider: new MockProvider([]),
      model: "test-model",
      tools: [],
    });
    expect(agent.setSystem("new")).toBe(agent);
  });

  test("direct ask override is wired through (non-interactive mode)", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "AskUser", { question: "color?" })] },
      { text: "ok" },
    ]);

    let askCalled = false;
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [
        {
          name: "AskUser",
          description: "ask",
          arguments: [{ name: "question", description: "q" }],
          execute: async (a) => a.question ?? "",
        },
        {
          name: "CompleteTask",
          description: "done",
          arguments: [{ name: "summary", description: "s" }],
          execute: async (a) => a.summary ?? "",
        },
      ],
      ask: async () => { askCalled = true; return "blue"; },
      confirm: async () => true,
    });

    await runOneTurn(agent, "ask me");
    expect(askCalled).toBe(true);
  });

  test("contextPruneInterval triggers manageContext on the actor's convo", async () => {
    // Two Echo calls at interval=2 should trigger the auto-prune path.
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Echo", { text: "1" })] },
      { toolCalls: [tc("c2", "Echo", { text: "2" })] },
      { text: "done" },
    ]);

    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [
        { name: "Echo", description: "echo", arguments: [{ name: "text", description: "t" }], execute: async (a) => a.text ?? "" },
        { name: "CompleteTask", description: "done", arguments: [{ name: "summary", description: "s" }], execute: async (a) => a.summary ?? "" },
      ],
      contextPruneInterval: 2,
    });

    const events = await runOneTurn(agent, "echo twice");

    // ManageContext is emitted as a tool_start/tool_done pair (special-cased by the loop).
    const saw = events.some(
      (e) => (e.type === "tool_start" && e.name === "ManageContext") ||
             (e.type === "tool_done" && e.name === "ManageContext"),
    );
    expect(saw).toBe(true);
  });

  test("classifySpawn routes Bash task commands to spawn()", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Bash", { command: "spawn:do-work" })] },
      { text: "done" },
    ]);

    let spawnTask = "";
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [
        { name: "Bash", description: "bash", arguments: [{ name: "command", description: "cmd" }], execute: async (a) => a.command ?? "" },
        { name: "CompleteTask", description: "done", arguments: [{ name: "summary", description: "s" }], execute: async (a) => a.summary ?? "" },
      ],
      classifySpawn: (call) => {
        const cmd = call.args.command ?? "";
        return cmd.startsWith("spawn:") ? cmd.slice(6) : null;
      },
      spawn: async (task) => {
        spawnTask = task;
        return { success: true, summary: "ok", exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await runOneTurn(agent, "spawn something");
    expect(spawnTask).toBe("do-work");
  });
});

// ---------------------------------------------------------------------------
// Review regressions & new options
// ---------------------------------------------------------------------------


const demoSkill = { name: "demo", description: "A demo skill", dir: "/tmp/demo", body: "body" };
const systemOf = (p: ScriptedProvider, i = 0) => p.calls[i]?.messages.find((m) => m.role === "system")?.content;

describe("AgentLoop — skills stay in the system prompt", () => {
  test("setSystem() and role:'system' messages keep the skills listing (merged once)", async () => {
    const provider = new ScriptedProvider([{ text: "a" }, { text: "b" }]);
    const agent = new AgentLoop({ provider, model: "m", system: "base", tools: [], skills: [demoSkill] });
    agent.setSystem("updated");
    await agent.sendSync("one");
    expect(systemOf(provider, 0)).toStartWith("updated");
    expect(systemOf(provider, 0)).toContain("/demo");

    await agent.sendSync({ role: "system", content: "from inbox" });
    await agent.sendSync("two");
    expect(systemOf(provider, 1)).toStartWith("from inbox");
    expect(systemOf(provider, 1)).toContain("/demo");

    // A prompt that already carries the listing is not merged twice.
    agent.setSystem(agent.convo.getSystem()!);
    expect(agent.convo.getSystem()!.split("AVAILABLE SKILLS").length).toBe(2);
    expect(agent.snapshot().system).toBe(agent.convo.getSystem());
    await agent.stop();
  });
});

describe("AgentLoop — defaults and new options", () => {
  test("max_tokens is not sent unless the host sets maxTokens", async () => {
    const provider = new ScriptedProvider([{ text: "a" }, { text: "b" }]);
    const a = new AgentLoop({ provider, model: "m", tools: [] });
    await a.sendSync("x");
    expect(provider.calls[0]!.maxTokens).toBeUndefined();
    await a.stop();
    const b = new AgentLoop({ provider, model: "m", tools: [], maxTokens: 4096 });
    await b.sendSync("y");
    expect(provider.calls[1]!.maxTokens).toBe(4096);
    await b.stop();
  });

  test("maxToolOutputChars caps tool results (default 50k)", async () => {
    const huge = { name: "Huge", description: "", arguments: [], execute: async () => "z".repeat(80_000) };
    const provider = new ScriptedProvider([
      { toolCalls: [tc("c1", "Huge", {})] }, { text: "ok" },
      { toolCalls: [tc("c2", "Huge", {})] }, { text: "ok" },
    ]);
    const def = new AgentLoop({ provider, model: "m", tools: [huge] });
    await def.sendSync("go");
    const t1 = def.convo.getHistory().find((m) => m.role === "tool")!;
    expect(t1.content.length).toBeLessThan(51_000);
    expect(t1.content).toContain("output capped at 50000");
    await def.stop();

    const off = new AgentLoop({ provider, model: "m", tools: [huge], maxToolOutputChars: 0 });
    await off.sendSync("go");
    expect(off.convo.getHistory().find((m) => m.role === "tool")!.content.length).toBe(80_000);
    await off.stop();
  });
});

describe("AgentLoop — context.compactAtTokens", () => {
  /** Strategy that records each call; drops everything but the last 2 messages when `shrink`. */
  function recordingStrategy(shrink: boolean) {
    const calls: Array<{ trigger: string; tokens?: number }> = [];
    const strategy: ContextStrategy = (graph, ctx) => {
      calls.push({ trigger: ctx.trigger, tokens: ctx.tokens });
      return shrink ? contextGraph(graph.agent, graph.nodes.slice(-2)) : graph;
    };
    return { calls, strategy };
  }
  const usage = (promptTokens: number) => ({ promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 });

  test("runs the strategy when the last request's promptTokens reach the threshold, passing tokens", async () => {
    const { calls, strategy } = recordingStrategy(true);
    const provider = new ScriptedProvider([
      { toolCalls: [tc("c1", "Echo", { text: "a" })], usage: usage(500) },
      { toolCalls: [tc("c2", "Echo", { text: "b" })], usage: usage(1500) },
      { text: "done", usage: usage(300) },
    ]);
    const agent = new AgentLoop({ provider, model: "m", tools: [echoTool], context: { strategy, compactAtTokens: 1000 } });
    const done: string[] = [];
    agent.on("tool_done", (e) => { if (e.name === "ManageContext") done.push(e.output); });
    await agent.sendSync("go");
    expect(calls).toEqual([{ trigger: "auto", tokens: 1500 }]);
    expect(done.length).toBe(1);
    await agent.stop();
  });

  test("does not re-fire every iteration when the strategy cannot get under the threshold", async () => {
    const { calls, strategy } = recordingStrategy(false);
    const provider = new ScriptedProvider([
      { toolCalls: [tc("c1", "Echo", { text: "a" })], usage: usage(2000) },
      { toolCalls: [tc("c2", "Echo", { text: "b" })], usage: usage(2100) },
      { toolCalls: [tc("c3", "Echo", { text: "c" })], usage: usage(500) },  // back under → re-arm
      { toolCalls: [tc("c4", "Echo", { text: "d" })], usage: usage(2200) },
      { text: "done" },
    ]);
    const agent = new AgentLoop({ provider, model: "m", tools: [echoTool], context: { strategy, compactAtTokens: 1000 } });
    await agent.sendSync("go");
    expect(calls.map((c) => c.tokens)).toEqual([2000, 2200]);
    await agent.stop();
  });

  test("falls back to a chars/4 estimate when the provider reports no usage", async () => {
    const { calls, strategy } = recordingStrategy(true);
    const provider = new ScriptedProvider([{ toolCalls: [tc("c1", "Echo", { text: "x".repeat(4000) })] }, { text: "done" }]);
    const agent = new AgentLoop({ provider, model: "m", tools: [echoTool], context: { strategy, compactAtTokens: 1000 } });
    await agent.sendSync("go");
    expect(calls.length).toBe(1);
    expect(calls[0]!.tokens!).toBeGreaterThanOrEqual(1000);
    await agent.stop();
  });

  test("a range { trigger, target } fires at trigger and passes targetTokens", async () => {
    const calls: Array<{ tokens?: number; targetTokens?: number }> = [];
    const strategy: ContextStrategy = (graph, ctx) => {
      calls.push({ tokens: ctx.tokens, targetTokens: ctx.targetTokens });
      return contextGraph(graph.agent, graph.nodes.slice(-2));
    };
    const provider = new ScriptedProvider([
      { toolCalls: [tc("c1", "Echo", { text: "a" })], usage: usage(800) },   // between target and trigger: no fire
      { toolCalls: [tc("c2", "Echo", { text: "b" })], usage: usage(1500) },  // ≥ trigger: fire
      { toolCalls: [tc("c3", "Echo", { text: "c" })], usage: usage(900) },   // above target, under trigger: no refire
      { toolCalls: [tc("c4", "Echo", { text: "d" })], usage: usage(1100) },  // trigger reached again: fire
      { text: "done" },
    ]);
    const agent = new AgentLoop({
      provider, model: "m", tools: [echoTool],
      context: { strategy, compactAtTokens: { trigger: 1000, target: 600 } },
    });
    await agent.sendSync("go");
    expect(calls).toEqual([{ tokens: 1500, targetTokens: 600 }, { tokens: 1100, targetTokens: 600 }]);
    await agent.stop();
  });

  test("a range does not re-fire every iteration when a run leaves history unchanged", async () => {
    const { calls, strategy } = recordingStrategy(false);
    const provider = new ScriptedProvider([
      { toolCalls: [tc("c1", "Echo", { text: "a" })], usage: usage(2000) },
      { toolCalls: [tc("c2", "Echo", { text: "b" })], usage: usage(2100) },
      { toolCalls: [tc("c3", "Echo", { text: "c" })], usage: usage(2200) },
      { text: "done" },
    ]);
    const agent = new AgentLoop({
      provider, model: "m", tools: [echoTool],
      context: { strategy, compactAtTokens: { trigger: 1000, target: 500 } },
    });
    await agent.sendSync("go");
    expect(calls.map((c) => c.tokens)).toEqual([2000]);
    await agent.stop();
  });

  test("a bare number passes no targetTokens; a bad range throws at construction", async () => {
    let seen: number | undefined = -1;
    const strategy: ContextStrategy = (graph, ctx) => { seen = ctx.targetTokens; return graph; };
    const provider = new ScriptedProvider([{ toolCalls: [tc("c1", "Echo", { text: "a" })], usage: usage(1500) }, { text: "done" }]);
    const agent = new AgentLoop({ provider, model: "m", tools: [echoTool], context: { strategy, compactAtTokens: 1000 } });
    await agent.sendSync("go");
    expect(seen).toBeUndefined();
    await agent.stop();

    const p = new ScriptedProvider([]);
    expect(() => new AgentLoop({ provider: p, model: "m", context: { compactAtTokens: { trigger: 1000, target: 1000 } } }))
      .toThrow("compactAtTokens.target (1000) must be below compactAtTokens.trigger (1000)");
  });

  test("context.everyToolCalls replaces contextPruneInterval (which still works)", async () => {
    for (const opts of [{ context: { everyToolCalls: 1 } }, { contextPruneInterval: 1 }]) {
      const { calls, strategy } = recordingStrategy(false);
      const provider = new ScriptedProvider([{ toolCalls: [tc("c1", "Echo", { text: "a" })] }, { text: "done" }]);
      const agent = new AgentLoop({ provider, model: "m", tools: [echoTool], contextStrategy: strategy, ...opts });
      await agent.sendSync("go");
      expect(calls.length).toBe(1);
      await agent.stop();
    }
  });
});
