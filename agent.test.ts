import { test, expect } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  JsonToolCall,
  StreamResult,
} from "./src/ai/types.ts";
import { AIConversation } from "./src/ai/builder.ts";
import { ToolRegistry } from "./src/tools/registry.ts";
import { run, mkWorld, type Effects, AbortError } from "./src/core/core.ts";

// ---------------------------------------------------------------------------
// Mock provider — returns pre-scripted JSON tool call responses as a stream
// ---------------------------------------------------------------------------

interface MockResponse {
  text?: string;
  toolCalls?: JsonToolCall[];
}

class MockProvider implements AIProvider {
  readonly name = "mock";
  private responses: MockResponse[];
  private callIndex = 0;

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async complete(_config: AIRequestConfig): Promise<AIResponse> {
    const resp = this.responses[this.callIndex++] ?? {};
    return {
      id: "mock",
      model: "mock",
      content: resp.text ?? null,
      finishReason: resp.toolCalls?.length ? "tool_calls" : "stop",
      ...(resp.toolCalls && { toolCalls: resp.toolCalls }),
    };
  }

  stream(_config: AIRequestConfig): StreamResult {
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

// ---------------------------------------------------------------------------
// Helper: create a minimal registry with a test tool
// ---------------------------------------------------------------------------

/** Shorthand to create a JsonToolCall */
function tc(id: string, name: string, args: Record<string, string>): JsonToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "Echo",
    description: "Returns its input",
    arguments: [{ name: "text", description: "text to echo" }],
    execute: async (args: Record<string, string>) => args.text ?? "empty",
  });
  registry.register({
    name: "CompleteTask",
    description: "Signal task completion",
    arguments: [{ name: "summary", description: "summary" }],
    execute: async (args: Record<string, string>) => args.summary ?? "Task complete.",
  });
  return registry;
}

// ---------------------------------------------------------------------------
// Recording effects
// ---------------------------------------------------------------------------

type FxEvent =
  | { type: "stream_done" }
  | { type: "tool_start"; name: string }
  | { type: "tool_done"; name: string; success: boolean }
  | { type: "confirm"; command: string }
  | { type: "remember"; content: string }
  | { type: "forget"; content: string }
  | { type: "system_refreshed" }
  | { type: "complete"; summary: string };

function createRecordingFx(opts?: { confirmResult?: boolean; askAnswer?: string }): {
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
    toolStart(name, _preview) { events.push({ type: "tool_start", name }); },
    toolDone(name, success, _output) { events.push({ type: "tool_done", name, success }); },
    confirm(command) {
      events.push({ type: "confirm", command });
      return Promise.resolve(opts?.confirmResult ?? true);
    },
    ask(_question) { return Promise.resolve(opts?.askAnswer ?? "test answer"); },
    remember: async (content) => { events.push({ type: "remember", content }); },
    forget: async (content) => { events.push({ type: "forget", content }); },
    refreshSystem: async () => { events.push({ type: "system_refreshed" }); },
    reboot: async () => { throw new Error("unreachable"); },
    manageContext: async () => "pruned",
    complete(summary) { events.push({ type: "complete", summary }); },
    installTool: async () => "installed",
    listTools: () => "no tools",
    spawn: async (_task) => ({ success: true, summary: "done", exitCode: 0, stdout: "", stderr: "" }),
  };

  return { fx, events, streamedText };
}

// ---------------------------------------------------------------------------
// Tests — exercise core.ts run() with the Form evaluator
// ---------------------------------------------------------------------------

test("plain text response — single stream, no tools", async () => {
  const provider = new MockProvider([{ text: "Hello, world!" }]);
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx, events, streamedText } = createRecordingFx();
  const world = mkWorld(convo, registry);

  await run("hi", world, fx);

  expect(streamedText).toEqual(["Hello, world!"]);
  expect(events).toEqual([{ type: "stream_done" }]);
});

test("single tool call — tool_start/tool_done around execution", async () => {
  const provider = new MockProvider([
    {
      text: "Let me echo that.",
      toolCalls: [tc("c1", "Echo", { text: "hello" })],
    },
    { text: "Done echoing." },
  ]);
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx, events, streamedText } = createRecordingFx();
  const world = mkWorld(convo, registry);

  await run("echo hello", world, fx);

  expect(streamedText.length).toBe(2);
  expect(streamedText[0]).toContain("Let me echo that.");
  expect(streamedText[1]).toBe("Done echoing.");

  const types = events.map(e => e.type);
  expect(types).toEqual([
    "stream_done",
    "tool_start",
    "tool_done",
    "stream_done",
  ]);
});

test("multiple tool calls in one response", async () => {
  const provider = new MockProvider([
    {
      text: "I'll echo twice.",
      toolCalls: [
        tc("c1", "Echo", { text: "one" }),
        tc("c2", "Echo", { text: "two" }),
      ],
    },
    { text: "Both echoed." },
  ]);
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx, events } = createRecordingFx();
  const world = mkWorld(convo, registry);

  await run("echo twice", world, fx);

  const types = events.map(e => e.type);
  expect(types).toEqual([
    "stream_done",
    "tool_start",
    "tool_done",
    "tool_start",
    "tool_done",
    "stream_done",
  ]);
});

test("multi-turn tool loop", async () => {
  const provider = new MockProvider([
    { toolCalls: [tc("c1", "Echo", { text: "step 1" })] },
    { toolCalls: [tc("c2", "Echo", { text: "step 2" })] },
    { text: "All steps done." },
  ]);
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx, events, streamedText } = createRecordingFx();
  const world = mkWorld(convo, registry);

  await run("do two steps", world, fx);

  const types = events.map(e => e.type);
  expect(types).toEqual([
    "stream_done",
    "tool_start",
    "tool_done",
    "stream_done",
    "tool_start",
    "tool_done",
    "stream_done",
  ]);

  expect(streamedText[streamedText.length - 1]).toBe("All steps done.");
});

test("CompleteTask stops the loop", async () => {
  const provider = new MockProvider([
    { toolCalls: [tc("c1", "Echo", { text: "work" })] },
    {
      text: "All done.",
      toolCalls: [tc("c2", "CompleteTask", { summary: "Finished the task" })],
    },
  ]);
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx, events } = createRecordingFx();
  const world = mkWorld(convo, registry);

  await run("do work", world, fx);

  const complete = events.find(e => e.type === "complete") as any;
  expect(complete.summary).toBe("Finished the task");
});

test("unknown tool returns error", async () => {
  const provider = new MockProvider([
    { toolCalls: [tc("c1", "NonExistent", { arg: "value" })] },
    { text: "Oh well." },
  ]);
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx, events } = createRecordingFx();
  const world = mkWorld(convo, registry);

  await run("call unknown", world, fx);

  const toolDone = events.find(e => e.type === "tool_done") as any;
  expect(toolDone.name).toBe("NonExistent");
  expect(toolDone.success).toBe(false);
});

test("abort signal stops execution", async () => {
  const provider = new MockProvider([{ text: "Hello, world!" }]);
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx } = createRecordingFx();

  const abort = new AbortController();
  abort.abort(); // abort immediately

  const world = mkWorld(convo, registry, abort.signal);

  await expect(run("hi", world, fx)).rejects.toThrow(AbortError);
});

test("parseInput routes /tools to ListTools form", async () => {
  const provider = new MockProvider([]); // no LLM calls expected
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx, streamedText } = createRecordingFx();
  const world = mkWorld(convo, registry);

  await run("/tools", world, fx);

  expect(streamedText.length).toBe(1);
  expect(streamedText[0]).toContain("tools"); // from mock listTools()
});

test("parseInput routes unknown commands to Emit", async () => {
  const provider = new MockProvider([]);
  const convo = new AIConversation(provider, "mock");
  const registry = createTestRegistry();
  const { fx, streamedText } = createRecordingFx();
  const world = mkWorld(convo, registry);

  await run("/unknown", world, fx);

  expect(streamedText.length).toBe(1);
  expect(streamedText[0]).toContain("Unknown command");
});
