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
