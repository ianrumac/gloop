import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  JsonToolCall,
  StreamResult,
} from "../ai/types.ts";
import { AIConversation } from "../ai/builder.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { jsonToolCallsToToolCalls } from "../tools/parser.ts";
import {
  run,
  eval_,
  mkWorld,
  toolCallsToForm,
  type Effects,
} from "./core.ts";

// ---------------------------------------------------------------------------
// Mock provider that returns StreamResult from stream()
// ---------------------------------------------------------------------------

interface MockResponse {
  text?: string;
  toolCalls?: JsonToolCall[];
}

class JsonMockProvider implements AIProvider {
  readonly name = "json-mock";
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
      for (let i = 0; i < text.length; i += 5) {
        yield text.slice(i, i + 5);
      }
    })();

    return {
      textStream,
      toolCalls: Promise.resolve(resp.toolCalls ?? []),
      cancel: async () => {},
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "Echo",
    description: "Returns its input",
    arguments: [{ name: "text", description: "text to echo" }],
    execute: async (args) => args.text ?? "empty",
  });
  registry.register({
    name: "CompleteTask",
    description: "Signal task completion",
    arguments: [{ name: "summary", description: "summary" }],
    execute: async (args) => args.summary ?? "Task complete.",
  });
  registry.register({
    name: "Bash",
    description: "Execute shell command",
    arguments: [{ name: "command", description: "command" }],
    execute: async (args) => `output of: ${args.command}`,
  });
  registry.register({
    name: "Remember",
    description: "Remember something",
    arguments: [{ name: "content", description: "content" }],
    execute: async (args) => args.content ?? "",
  });
  registry.register({
    name: "Forget",
    description: "Forget something",
    arguments: [{ name: "content", description: "content" }],
    execute: async (args) => args.content ?? "",
  });
  return registry;
}

type FxEvent =
  | { type: "stream_done" }
  | { type: "tool_start"; name: string }
  | { type: "tool_done"; name: string; success: boolean }
  | { type: "complete"; summary: string }
  | { type: "remember"; content: string }
  | { type: "forget"; content: string };

function createRecordingFx(): {
  fx: Effects;
  events: FxEvent[];
  streamedText: string[];
} {
  const events: FxEvent[] = [];
  const streamedText: string[] = [];
  let currentStream = "";

  const fx: Effects = {
    streamChunk(text) { currentStream += text; },
    streamDone() {
      if (currentStream) streamedText.push(currentStream);
      currentStream = "";
      events.push({ type: "stream_done" });
    },
    toolStart(name) { events.push({ type: "tool_start", name }); },
    toolDone(name, success) { events.push({ type: "tool_done", name, success }); },
    confirm: async () => true,
    ask: async () => "answer",
    remember: async (content) => { events.push({ type: "remember", content }); },
    forget: async (content) => { events.push({ type: "forget", content }); },
    refreshSystem: async () => {},
    reboot: async () => { throw new Error("reboot"); },
    manageContext: async () => "pruned",
    complete(summary) { events.push({ type: "complete", summary }); },
    installTool: async () => "installed",
    listTools: () => "tools",
    spawn: async () => ({ success: true, summary: "ok", exitCode: 0, stdout: "", stderr: "" }),
  };

  return { fx, events, streamedText };
}

// ---------------------------------------------------------------------------
// jsonToolCallsToToolCalls tests
// ---------------------------------------------------------------------------

describe("jsonToolCallsToToolCalls", () => {
  test("converts single tool call with JSON args", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: {
        name: "ReadFile",
        arguments: '{"path":"./README.md"}',
      },
    }]);

    expect(result).toEqual([
      { name: "ReadFile", rawArgs: ["./README.md"] },
    ]);
  });

  test("converts multiple tool calls", () => {
    const result = jsonToolCallsToToolCalls([
      {
        id: "call_1",
        type: "function",
        function: { name: "ReadFile", arguments: '{"path":"a.ts"}' },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "ReadFile", arguments: '{"path":"b.ts"}' },
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].rawArgs).toEqual(["a.ts"]);
    expect(result[1].rawArgs).toEqual(["b.ts"]);
  });

  test("converts tool call with multiple args", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: {
        name: "WriteFile",
        arguments: '{"path":"out.txt","content":"hello world"}',
      },
    }]);

    expect(result).toEqual([
      { name: "WriteFile", rawArgs: ["out.txt", "hello world"] },
    ]);
  });

  test("handles empty arguments", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: { name: "Reload", arguments: "{}" },
    }]);

    expect(result).toEqual([{ name: "Reload", rawArgs: [] }]);
  });

  test("handles malformed JSON arguments", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: { name: "Bash", arguments: "not json" },
    }]);

    expect(result).toEqual([{ name: "Bash", rawArgs: ["not json"] }]);
  });

  test("handles empty arguments string", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: { name: "Reload", arguments: "" },
    }]);

    expect(result).toEqual([{ name: "Reload", rawArgs: [] }]);
  });
});

// ---------------------------------------------------------------------------
// toolCallsToForm tests
// ---------------------------------------------------------------------------

describe("toolCallsToForm", () => {
  test("empty calls returns Nil", () => {
    const form = toolCallsToForm([]);
    expect(form.tag).toBe("nil");
  });

  test("regular tool call returns Invoke", () => {
    const form = toolCallsToForm([{ name: "Echo", rawArgs: ["hi"] }]);
    expect(form.tag).toBe("invoke");
  });

  test("CompleteTask returns Done", () => {
    const form = toolCallsToForm([{ name: "CompleteTask", rawArgs: ["finished"] }]);
    expect(form.tag).toBe("done");
    if (form.tag === "done") expect(form.summary).toBe("finished");
  });

  test("mixed regular + CompleteTask invokes tools first", () => {
    const form = toolCallsToForm([
      { name: "Echo", rawArgs: ["work"] },
      { name: "CompleteTask", rawArgs: ["done"] },
    ]);
    expect(form.tag).toBe("invoke");
    if (form.tag === "invoke") {
      expect(form.calls).toHaveLength(1);
      expect(form.calls[0].name).toBe("Echo");
      const next = form.then([]);
      expect(next.tag).toBe("done");
    }
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry.toJsonTools tests
// ---------------------------------------------------------------------------

describe("ToolRegistry.toJsonTools", () => {
  test("converts tools to JSON format", () => {
    const registry = createTestRegistry();
    const jsonTools = registry.toJsonTools();

    const echo = jsonTools.find(t => t.function.name === "Echo");
    expect(echo).toBeTruthy();
    expect(echo!.type).toBe("function");
    expect(echo!.function.description).toBe("Returns its input");
    expect(echo!.function.parameters.type).toBe("object");
    expect(echo!.function.parameters.properties).toHaveProperty("text");
    expect(echo!.function.parameters.properties.text.type).toBe("string");
    expect(echo!.function.parameters.required).toEqual(["text"]);
  });

  test("tool with no arguments has empty properties", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "Reload",
      description: "Reload tools",
      arguments: [],
      execute: async () => "ok",
    });
    const jsonTools = registry.toJsonTools();

    expect(jsonTools).toHaveLength(1);
    expect(jsonTools[0].function.parameters.properties).toEqual({});
    expect(jsonTools[0].function.parameters.required).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JSON mode agent loop integration tests
// ---------------------------------------------------------------------------

describe("JSON mode agent loop", () => {
  test("text-only response — no tool calls", async () => {
    const provider = new JsonMockProvider([
      { text: "Hello, world!" },
    ]);
    const convo = new AIConversation(provider, "mock");
    const registry = createTestRegistry();
    const { fx, events, streamedText } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("hi", world, fx);

    expect(streamedText).toEqual(["Hello, world!"]);
    expect(events).toEqual([{ type: "stream_done" }]);
  });

  test("single JSON tool call — executes and loops", async () => {
    const provider = new JsonMockProvider([
      {
        text: "Let me echo that.",
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: { name: "Echo", arguments: '{"text":"hello"}' },
        }],
      },
      { text: "Done echoing." },
    ]);
    const convo = new AIConversation(provider, "mock");
    const registry = createTestRegistry();
    const { fx, events, streamedText } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("echo hello", world, fx);

    expect(streamedText).toContain("Done echoing.");

    const starts = events.filter(e => e.type === "tool_start");
    expect(starts.length).toBeGreaterThanOrEqual(1);
  });

  test("CompleteTask via JSON stops the loop", async () => {
    const provider = new JsonMockProvider([
      {
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: { name: "CompleteTask", arguments: '{"summary":"All done"}' },
        }],
      },
    ]);
    const convo = new AIConversation(provider, "mock");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("finish", world, fx);

    const complete = events.find(e => e.type === "complete") as any;
    expect(complete).toBeTruthy();
    expect(complete.summary).toBe("All done");
  });

  test("multiple JSON tool calls in one response", async () => {
    const provider = new JsonMockProvider([
      {
        toolCalls: [
          { id: "c1", type: "function", function: { name: "Echo", arguments: '{"text":"one"}' } },
          { id: "c2", type: "function", function: { name: "Echo", arguments: '{"text":"two"}' } },
        ],
      },
      { text: "Both echoed." },
    ]);
    const convo = new AIConversation(provider, "mock");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("echo twice", world, fx);

    const toolStarts = events.filter(e => e.type === "tool_start");
    expect(toolStarts.length).toBeGreaterThanOrEqual(2);
  });

  test("tools are forwarded to provider", async () => {
    const provider = new JsonMockProvider([
      { text: "No tools needed." },
    ]);
    const convo = new AIConversation(provider, "mock");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("test", world, fx);

    // Provider should have received tools in the config
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools).toBeDefined();
    expect(provider.calls[0].tools!.length).toBeGreaterThan(0);
    expect(provider.calls[0].tools!.some(t => t.function.name === "Echo")).toBe(true);
  });

  test("Remember tool calls fx.remember", async () => {
    const provider = new JsonMockProvider([
      {
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: { name: "Remember", arguments: '{"content":"user prefers dark mode"}' },
        }],
      },
      { text: "Noted." },
    ]);
    const convo = new AIConversation(provider, "mock");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("remember dark mode", world, fx);

    expect(events.some(e => e.type === "remember" && (e as any).content === "user prefers dark mode")).toBe(true);
  });

  test("Forget tool calls fx.forget", async () => {
    const provider = new JsonMockProvider([
      {
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: { name: "Forget", arguments: '{"content":"old pref"}' },
        }],
      },
      { text: "Forgotten." },
    ]);
    const convo = new AIConversation(provider, "mock");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("forget old pref", world, fx);

    expect(events.some(e => e.type === "forget" && (e as any).content === "old pref")).toBe(true);
  });
});
