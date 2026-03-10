import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  JsonToolCall,
} from "../src/ai/types.js";
import { AgentLoop } from "../src/agent.js";
import { AbortError } from "../src/core/core.js";

// ---------------------------------------------------------------------------
// Mock provider (same pattern as core.test.ts)
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
      for (let i = 0; i < text.length; i += 10) {
        yield text.slice(i, i + 10);
      }
    })();
    return {
      textStream,
      toolCalls: Promise.resolve(resp.toolCalls ?? []),
      cancel: async () => {},
    };
  }
}

function tc(id: string, name: string, args: Record<string, string>): JsonToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

// ---------------------------------------------------------------------------
// AgentLoop tests
// ---------------------------------------------------------------------------

describe("AgentLoop", () => {
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

  test("constructor uses primitiveTools when no tools provided", () => {
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

    // primitiveTools registers: ReadFile, WriteFile, Patch_file, Bash, CompleteTask, AskUser, Remember, Forget, ManageContext
    expect(agent.registry.has("ReadFile")).toBe(true);
    expect(agent.registry.has("Bash")).toBe(true);
    expect(agent.registry.has("CompleteTask")).toBe(true);
    expect(agent.registry.has("AskUser")).toBe(true);
  });

  test("run() delegates to core.run and streams text", async () => {
    const provider = new MockProvider([{ text: "Hello from agent!" }]);
    const streamed: string[] = [];

    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
      onStream: (text) => streamed.push(text),
    });

    await agent.run("hi");

    expect(streamed.join("")).toBe("Hello from agent!\n");
  });

  test("run() executes tool calls", async () => {
    const executed: string[] = [];
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "MyTool", { input: "test" })] },
      { text: "Done." },
    ]);

    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [
        {
          name: "MyTool",
          description: "Test tool",
          arguments: [{ name: "input", description: "input" }],
          execute: async (args) => {
            executed.push(args.input ?? "");
            return "result";
          },
        },
        {
          name: "CompleteTask",
          description: "Complete",
          arguments: [{ name: "summary", description: "s" }],
          execute: async (args) => args.summary ?? "",
        },
      ],
      onStream: () => {},
    });

    await agent.run("use tool");
    expect(executed).toEqual(["test"]);
  });

  test("clear() resets conversation history and tool call counter", async () => {
    const provider = new MockProvider([
      { text: "First response" },
      { text: "Second response" },
    ]);

    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
      onStream: () => {},
    });

    await agent.run("first");
    expect(agent.convo.getHistory().length).toBeGreaterThan(0);

    agent.clear();
    expect(agent.convo.getHistory()).toEqual([]);
    expect(agent.world.toolCalls).toBe(0);
  });

  test("clear() returns this for chaining", () => {
    const provider = new MockProvider([]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
    });

    const result = agent.clear();
    expect(result).toBe(agent);
  });

  test("addTool() registers a new tool", () => {
    const provider = new MockProvider([]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
    });

    expect(agent.registry.has("NewTool")).toBe(false);

    agent.addTool({
      name: "NewTool",
      description: "A new tool",
      arguments: [],
      execute: async () => "new",
    });

    expect(agent.registry.has("NewTool")).toBe(true);
  });

  test("addTool() returns this for chaining", () => {
    const provider = new MockProvider([]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
    });

    const result = agent.addTool({
      name: "T",
      description: "t",
      arguments: [],
      execute: async () => "",
    });
    expect(result).toBe(agent);
  });

  test("setSystem() updates the system prompt", async () => {
    const provider = new MockProvider([
      { text: "response" },
    ]);

    const agent = new AgentLoop({
      provider,
      model: "test-model",
      system: "initial prompt",
      tools: [],
      onStream: () => {},
    });

    agent.setSystem("updated prompt");
    await agent.run("test");

    // The provider should receive the updated system prompt
    const messages = provider.calls[0]?.messages;
    const systemMsg = messages?.find(m => m.role === "system");
    expect(systemMsg?.content).toBe("updated prompt");
  });

  test("setSystem() returns this for chaining", () => {
    const provider = new MockProvider([]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
    });

    const result = agent.setSystem("new");
    expect(result).toBe(agent);
  });

  test("abort signal cancels run", async () => {
    const abort = new AbortController();
    abort.abort(); // pre-abort

    const provider = new MockProvider([{ text: "should not see" }]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
      signal: abort.signal,
      onStream: () => {},
    });

    await expect(agent.run("test")).rejects.toThrow(AbortError);
  });

  test("effect overrides are wired through", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "AskUser", { question: "color?" })] },
      { text: "ok" },
    ]);

    let askCalled = false;
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [
        { name: "AskUser", description: "ask", arguments: [{ name: "question", description: "q" }], execute: async (a) => a.question ?? "" },
        { name: "CompleteTask", description: "done", arguments: [{ name: "summary", description: "s" }], execute: async (a) => a.summary ?? "" },
      ],
      onStream: () => {},
      ask: async (q) => { askCalled = true; return "blue"; },
      confirm: async () => true,
    });

    await agent.run("ask me");
    expect(askCalled).toBe(true);
  });

  test("contextPruneInterval is forwarded to loop config", async () => {
    // Create enough responses to trigger auto-prune at interval=2
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Echo", { text: "1" })] },
      { toolCalls: [tc("c2", "Echo", { text: "2" })] },
      { text: "done" },
    ]);

    let manageContextCalled = false;
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [
        { name: "Echo", description: "echo", arguments: [{ name: "text", description: "t" }], execute: async (a) => a.text ?? "" },
        { name: "CompleteTask", description: "done", arguments: [{ name: "summary", description: "s" }], execute: async (a) => a.summary ?? "" },
      ],
      contextPruneInterval: 2,
      onStream: () => {},
    });

    // Patch manageContext on the effects to detect the call
    const origManageContext = agent.effects.manageContext;
    agent.effects.manageContext = async (instructions) => {
      manageContextCalled = true;
      return "pruned";
    };

    await agent.run("echo twice");
    expect(manageContextCalled).toBe(true);
  });

  test("classifySpawn is forwarded to loop config", async () => {
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
        const cmd = call.rawArgs[0] ?? "";
        if (cmd.startsWith("spawn:")) return cmd.slice(6);
        return null;
      },
      spawn: async (task) => {
        spawnTask = task;
        return { success: true, summary: "ok", exitCode: 0, stdout: "", stderr: "" };
      },
      onStream: () => {},
    });

    await agent.run("spawn something");
    expect(spawnTask).toBe("do-work");
  });
});
