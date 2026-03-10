import { test, expect, describe } from "bun:test";
import { AIBuilder, AI, AIConversation } from "../src/ai/builder.js";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
} from "../src/ai/types.js";

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

class MockProvider implements AIProvider {
  readonly name = "mock";
  lastConfig: AIRequestConfig | null = null;
  private responses: string[];
  private callIndex = 0;

  constructor(responses: string[] = ["mock response"]) {
    this.responses = responses;
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    this.lastConfig = config;
    const content = this.responses[this.callIndex++] ?? "";
    return { id: "mock-id", model: config.model, content, finishReason: "stop" };
  }

  stream(config: AIRequestConfig): StreamResult {
    this.lastConfig = config;
    const content = this.responses[this.callIndex++] ?? "";
    const textStream: AsyncIterableIterator<string> = (async function* () {
      for (let i = 0; i < content.length; i += 5) {
        yield content.slice(i, i + 5);
      }
    })();
    return {
      textStream,
      toolCalls: Promise.resolve([]),
      cancel: async () => {},
    };
  }
}

// ---------------------------------------------------------------------------
// AIBuilder tests
// ---------------------------------------------------------------------------

describe("AIBuilder", () => {
  test("throws if no model is set", () => {
    const provider = new MockProvider();
    const builder = new AIBuilder(provider);
    expect(() => builder.stream()).toThrow("Model must be specified");
  });

  test("query sends messages to provider", async () => {
    const provider = new MockProvider(["hello"]);
    const builder = new AIBuilder(provider, "test-model");
    builder.prompt("test input");
    const response = await builder.query();

    expect(response.content).toBe("hello");
    expect(response.model).toBe("test-model");
    expect(provider.lastConfig!.messages).toEqual([
      { role: "user", content: "test input" },
    ]);
  });

  test("system message is prepended", async () => {
    const provider = new MockProvider(["ok"]);
    const builder = new AIBuilder(provider, "m");
    builder.system("You are helpful").prompt("hi");
    await builder.query();

    expect(provider.lastConfig!.messages).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  test("chained configuration methods", async () => {
    const provider = new MockProvider(["ok"]);
    const builder = new AIBuilder(provider, "m");
    builder
      .temperature(0.5)
      .maxTokens(100)
      .topP(0.9)
      .stop(["END"])
      .seed(42)
      .prompt("test");

    await builder.query();
    expect(provider.lastConfig!.temperature).toBe(0.5);
    expect(provider.lastConfig!.maxTokens).toBe(100);
    expect(provider.lastConfig!.topP).toBe(0.9);
    expect(provider.lastConfig!.stop).toEqual(["END"]);
    expect(provider.lastConfig!.seed).toBe(42);
  });

  test("lazy values are resolved at query time", async () => {
    const provider = new MockProvider(["ok"]);
    let modelName = "model-a";
    const builder = new AIBuilder(provider);
    builder.model(() => modelName).prompt("hi");

    modelName = "model-b";
    await builder.query();

    expect(provider.lastConfig!.model).toBe("model-b");
  });

  test("lazy system prompt resolved at query time", async () => {
    const provider = new MockProvider(["ok"]);
    let sys = "initial";
    const builder = new AIBuilder(provider, "m");
    builder.system(() => sys).prompt("hi");

    sys = "updated system";
    await builder.query();

    expect(provider.lastConfig!.messages[0]).toEqual({
      role: "system",
      content: "updated system",
    });
  });

  test("messages() accepts lazy arrays", async () => {
    const provider = new MockProvider(["ok"]);
    const history = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "reply" },
    ];
    const builder = new AIBuilder(provider, "m");
    builder.messages(() => history).prompt("next");

    await builder.query();
    expect(provider.lastConfig!.messages).toHaveLength(3);
    expect(provider.lastConfig!.messages[0].content).toBe("first");
    expect(provider.lastConfig!.messages[2].content).toBe("next");
  });

  test("streamToCompletion collects full content", async () => {
    const provider = new MockProvider(["streamed content"]);
    const builder = new AIBuilder(provider, "m");
    builder.prompt("test");

    const response = await builder.streamToCompletion();
    expect(response.content).toBe("streamed content");
    expect(response.finishReason).toBe("stop");
  });

  test("stream yields chunks", async () => {
    const provider = new MockProvider(["hello world"]);
    const builder = new AIBuilder(provider, "m");
    builder.prompt("test");

    const result = builder.stream();
    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("hello world");
  });

  test("assistant() adds assistant message", async () => {
    const provider = new MockProvider(["ok"]);
    const builder = new AIBuilder(provider, "m");
    builder.prompt("hi").assistant("previous reply").prompt("continue");

    await builder.query();
    expect(provider.lastConfig!.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "previous reply" },
      { role: "user", content: "continue" },
    ]);
  });

  test("providerRouting is forwarded", async () => {
    const provider = new MockProvider(["ok"]);
    const builder = new AIBuilder(provider, "m");
    builder.providerRouting({ only: ["openai"] }).prompt("hi");

    await builder.query();
    expect(provider.lastConfig!.provider).toEqual({ only: ["openai"] });
  });
});

// ---------------------------------------------------------------------------
// AI factory tests
// ---------------------------------------------------------------------------

describe("AI", () => {
  test("model() creates a builder with specified model", async () => {
    const provider = new MockProvider(["ok"]);
    const ai = new AI(provider, "default-model");
    const builder = ai.model("custom-model");
    builder.prompt("test");
    await builder.query();

    expect(provider.lastConfig!.model).toBe("custom-model");
  });

  test("chat() uses default model", async () => {
    const provider = new MockProvider(["ok"]);
    const ai = new AI(provider, "default-model");
    const builder = ai.chat();
    builder.prompt("test");
    await builder.query();

    expect(provider.lastConfig!.model).toBe("default-model");
  });

  test("chat() throws without default model", () => {
    const provider = new MockProvider();
    const ai = new AI(provider);
    expect(() => ai.chat()).toThrow("No default model set");
  });

  test("conversation() creates AIConversation", () => {
    const provider = new MockProvider();
    const ai = new AI(provider, "default");
    const convo = ai.conversation();
    expect(convo).toBeInstanceOf(AIConversation);
  });

  test("conversation() throws without model", () => {
    const provider = new MockProvider();
    const ai = new AI(provider);
    expect(() => ai.conversation()).toThrow("No model specified");
  });
});

// ---------------------------------------------------------------------------
// AIConversation tests
// ---------------------------------------------------------------------------

describe("AIConversation", () => {
  test("send() adds user/assistant messages to history", async () => {
    const provider = new MockProvider(["Reply 1", "Reply 2"]);
    const convo = new AIConversation(provider, "m", "system");

    await convo.send("Hello");
    expect(convo.getHistory()).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Reply 1" },
    ]);

    await convo.send("Follow up");
    expect(convo.getHistory()).toHaveLength(4);
    expect(convo.getHistory()[3].content).toBe("Reply 2");
  });

  test("send() includes system prompt in request", async () => {
    const provider = new MockProvider(["ok"]);
    const convo = new AIConversation(provider, "m", "Be helpful");
    await convo.send("hi");

    expect(provider.lastConfig!.messages[0]).toEqual({
      role: "system",
      content: "Be helpful",
    });
  });

  test("stream() yields chunks and adds to history", async () => {
    const provider = new MockProvider(["stream text"]);
    const convo = new AIConversation(provider, "m");

    const chunks: string[] = [];
    const result = convo.stream("test");
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("stream text");
    expect(convo.getHistory()).toEqual([
      { role: "user", content: "test" },
      { role: "assistant", content: "stream text" },
    ]);
  });

  test("stream() does not add empty assistant message", async () => {
    const provider = new MockProvider([""]);
    const convo = new AIConversation(provider, "m");

    const result = convo.stream("test");
    for await (const _chunk of result.textStream) {
      // consume stream
    }

    // Only user message, no empty assistant message
    expect(convo.getHistory()).toEqual([
      { role: "user", content: "test" },
    ]);
  });

  test("getHistory() returns a copy", () => {
    const provider = new MockProvider();
    const convo = new AIConversation(provider, "m");
    const h1 = convo.getHistory();
    h1.push({ role: "user", content: "injected" });
    expect(convo.getHistory()).toHaveLength(0);
  });

  test("setHistory() replaces history with a copy", async () => {
    const provider = new MockProvider(["ok"]);
    const convo = new AIConversation(provider, "m");
    await convo.send("original");

    convo.setHistory([{ role: "user", content: "replaced" }]);
    expect(convo.getHistory()).toEqual([
      { role: "user", content: "replaced" },
    ]);
  });

  test("clear() empties history", async () => {
    const provider = new MockProvider(["ok"]);
    const convo = new AIConversation(provider, "m");
    await convo.send("msg");
    expect(convo.getHistory().length).toBeGreaterThan(0);

    convo.clear();
    expect(convo.getHistory()).toHaveLength(0);
  });

  test("setSystem() changes system prompt", async () => {
    const provider = new MockProvider(["ok", "ok"]);
    const convo = new AIConversation(provider, "m", "initial");
    await convo.send("first");
    expect(provider.lastConfig!.messages[0].content).toBe("initial");

    convo.setSystem("updated");
    await convo.send("second");
    expect(provider.lastConfig!.messages[0].content).toBe("updated");
  });

  test("fork() creates new conversation with fresh history", async () => {
    const provider = new MockProvider(["ok", "forked reply"]);
    const original = new AIConversation(provider, "m", "original system");
    await original.send("msg");

    const forked = original.fork("forked system");
    expect(forked.getHistory()).toHaveLength(0);

    await forked.send("forked msg");
    expect(provider.lastConfig!.messages[0].content).toBe("forked system");
  });

  test("fork() preserves provider routing", async () => {
    const provider = new MockProvider(["ok"]);
    const original = new AIConversation(provider, "m");
    original.setProviderRouting({ only: ["test-provider"] });

    const forked = original.fork("sys");
    await forked.send("test");
    expect(provider.lastConfig!.provider).toEqual({ only: ["test-provider"] });
  });

  test("send() with null content does not add assistant message", async () => {
    // Mock a provider that returns null content
    const provider: AIProvider = {
      name: "null-provider",
      async complete(): Promise<AIResponse> {
        return { id: "x", model: "m", content: null, finishReason: "stop" };
      },
      stream(): StreamResult {
        const textStream: AsyncIterableIterator<string> = (async function* () {})();
        return { textStream, toolCalls: Promise.resolve([]), cancel: async () => {} };
      },
    };

    const convo = new AIConversation(provider, "m");
    await convo.send("hi");

    // Only user message — no assistant message for null content
    expect(convo.getHistory()).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  test("multiple turns accumulate history correctly", async () => {
    const provider = new MockProvider(["r1", "r2", "r3"]);
    const convo = new AIConversation(provider, "m");

    await convo.send("q1");
    await convo.send("q2");
    await convo.send("q3");

    const history = convo.getHistory();
    expect(history).toHaveLength(6);
    expect(history.map(m => m.content)).toEqual(["q1", "r1", "q2", "r2", "q3", "r3"]);
  });

  test("setJsonTools forwards tools to provider", async () => {
    const provider = new MockProvider(["ok"]);
    const convo = new AIConversation(provider, "m");
    convo.setJsonTools([{
      type: "function",
      function: {
        name: "TestTool",
        description: "A test tool",
        parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
      },
    }]);
    await convo.send("use tool");
    expect(provider.lastConfig!.tools).toBeDefined();
    expect(provider.lastConfig!.tools![0].function.name).toBe("TestTool");
  });

  test("clearJsonTools removes tools from requests", async () => {
    const provider = new MockProvider(["ok", "ok"]);
    const convo = new AIConversation(provider, "m");
    convo.setJsonTools([{
      type: "function",
      function: {
        name: "Tool",
        description: "desc",
        parameters: { type: "object", properties: {} },
      },
    }]);
    await convo.send("first");
    expect(provider.lastConfig!.tools).toBeDefined();

    convo.clearJsonTools();
    await convo.send("second");
    expect(provider.lastConfig!.tools).toBeUndefined();
  });

  test("setJsonTools with empty array clears tools", async () => {
    const provider = new MockProvider(["ok"]);
    const convo = new AIConversation(provider, "m");
    convo.setJsonTools([]);
    await convo.send("test");
    expect(provider.lastConfig!.tools).toBeUndefined();
  });

  test("stream() return value has cancel function", () => {
    const provider = new MockProvider(["text"]);
    const convo = new AIConversation(provider, "m");
    const result = convo.stream("test");
    expect(typeof result.cancel).toBe("function");
    expect(result.toolCalls).toBeInstanceOf(Promise);
  });
});
