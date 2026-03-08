import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  AIStreamChunk,
  JsonToolCall,
  ToolCallDelta,
} from "../ai/types.ts";
import { AIConversation } from "../ai/builder.ts";
import { ToolRegistry } from "../tools/registry.ts";
import {
  run,
  eval_,
  mkWorld,
  toolCallsToForm,
  parseInput,
  Think,
  Invoke,
  Emit,
  Nil,
  Done,
  Seq,
  Remember,
  Forget,
  Confirm,
  Ask,
  Refresh,
  Reboot,
  Install,
  ListTools,
  Spawn,
  AbortError,
  type Form,
  type Effects,
  type World,
} from "./core.ts";

// ---------------------------------------------------------------------------
// Mock provider that returns JSON tool calls in stream
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

  async *stream(config: AIRequestConfig): AsyncGenerator<AIStreamChunk, void, unknown> {
    this.calls.push(config);
    const resp = this.responses[this.callIndex++] ?? {};

    // Stream text content
    if (resp.text) {
      for (let i = 0; i < resp.text.length; i += 10) {
        yield {
          id: "mock",
          model: "mock",
          delta: { content: resp.text.slice(i, i + 10) },
          finishReason: null,
        };
      }
    }

    // Stream tool calls as ToolCallDelta (with index)
    if (resp.toolCalls) {
      const deltas: ToolCallDelta[] = resp.toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
      yield {
        id: "mock",
        model: "mock",
        delta: { toolCalls: deltas },
        finishReason: "tool_calls",
      };
    } else {
      yield { id: "mock", model: "mock", delta: {}, finishReason: "stop" };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
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
    execute: async (args) => args.text ?? "empty",
  });
  registry.register({
    name: "Fail",
    description: "Always fails",
    arguments: [{ name: "msg", description: "error message" }],
    execute: async (args) => { throw new Error(args.msg ?? "deliberate failure"); },
  });
  registry.register({
    name: "CompleteTask",
    description: "Signal task completion",
    arguments: [{ name: "summary", description: "summary" }],
    execute: async (args) => args.summary ?? "Task complete.",
  });
  registry.register({
    name: "AskUser",
    description: "Ask user a question",
    arguments: [{ name: "question", description: "question" }],
    execute: async (args) => args.question ?? "?",
  });
  registry.register({
    name: "Reload",
    description: "Reload tools",
    arguments: [],
    execute: async () => "Reloaded",
  });
  registry.register({
    name: "ManageContext",
    description: "Context management",
    arguments: [{ name: "instructions", description: "instructions" }],
    execute: async (args) => args.instructions ?? "prune",
  });
  registry.register({
    name: "DangerTool",
    description: "A tool that requires confirmation",
    arguments: [{ name: "action", description: "action" }],
    askPermission: (args) => args.action === "destroy" ? "Will destroy things" : null,
    execute: async (args) => `Did: ${args.action}`,
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
  | { type: "stream_chunk"; text: string }
  | { type: "stream_done" }
  | { type: "tool_start"; name: string }
  | { type: "tool_done"; name: string; success: boolean; output: string }
  | { type: "confirm"; command: string }
  | { type: "ask"; question: string }
  | { type: "remember"; content: string }
  | { type: "forget"; content: string }
  | { type: "system_refreshed" }
  | { type: "complete"; summary: string }
  | { type: "install"; source: string }
  | { type: "list-tools" }
  | { type: "spawn"; task: string };

function createRecordingFx(opts?: {
  confirmResult?: boolean;
  askAnswer?: string;
  spawnResult?: { success: boolean; summary: string; exitCode: number; stdout: string; stderr: string };
}): {
  fx: Effects;
  events: FxEvent[];
  streamedText: string[];
} {
  const events: FxEvent[] = [];
  const streamedText: string[] = [];
  let currentStream = "";

  const fx: Effects = {
    streamChunk(text) {
      currentStream += text;
      events.push({ type: "stream_chunk", text });
    },
    streamDone() {
      if (currentStream) streamedText.push(currentStream);
      currentStream = "";
      events.push({ type: "stream_done" });
    },
    toolStart(name) { events.push({ type: "tool_start", name }); },
    toolDone(name, success, output) { events.push({ type: "tool_done", name, success, output }); },
    confirm(command) {
      events.push({ type: "confirm", command });
      return Promise.resolve(opts?.confirmResult ?? true);
    },
    ask(question) {
      events.push({ type: "ask", question });
      return Promise.resolve(opts?.askAnswer ?? "user answer");
    },
    remember: async (content) => { events.push({ type: "remember", content }); },
    forget: async (content) => { events.push({ type: "forget", content }); },
    refreshSystem: async () => { events.push({ type: "system_refreshed" }); },
    reboot: async (reason) => { throw new Error(`reboot: ${reason}`); },
    manageContext: async () => "pruned",
    complete(summary) { events.push({ type: "complete", summary }); },
    installTool: async (source) => { events.push({ type: "install", source }); return "installed"; },
    listTools: () => { events.push({ type: "list-tools" }); return "tool list"; },
    spawn: async (task) => {
      events.push({ type: "spawn", task });
      return opts?.spawnResult ?? { success: true, summary: "spawned ok", exitCode: 0, stdout: "", stderr: "" };
    },
  };

  return { fx, events, streamedText };
}

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

  test("Reboot call returns Reboot form", () => {
    const form = toolCallsToForm([{ name: "Reboot", rawArgs: ["code updated"] }]);
    expect(form.tag).toBe("reboot");
  });

  test("Reboot with regular tools runs tools first", () => {
    const form = toolCallsToForm([
      { name: "Echo", rawArgs: ["save"] },
      { name: "Reboot", rawArgs: ["update"] },
    ]);
    expect(form.tag).toBe("invoke");
    if (form.tag === "invoke") {
      expect(form.calls[0].name).toBe("Echo");
      const next = form.then([]);
      expect(next.tag).toBe("reboot");
    }
  });
});

// ---------------------------------------------------------------------------
// parseInput tests
// ---------------------------------------------------------------------------

describe("parseInput", () => {
  test("plain text becomes Think", () => {
    const form = parseInput("hello");
    expect(form.tag).toBe("think");
    if (form.tag === "think") expect(form.input).toBe("hello");
  });

  test("/tools becomes ListTools", () => {
    expect(parseInput("/tools").tag).toBe("list-tools");
  });

  test("/install with arg becomes Install", () => {
    const form = parseInput("/install https://example.com/tool.ts");
    expect(form.tag).toBe("install");
    if (form.tag === "install") expect(form.source).toBe("https://example.com/tool.ts");
  });

  test("/install without arg becomes Emit with usage", () => {
    const form = parseInput("/install");
    expect(form.tag).toBe("emit");
    if (form.tag === "emit") expect(form.text).toContain("Usage");
  });

  test("unknown /command becomes Emit", () => {
    const form = parseInput("/foo");
    expect(form.tag).toBe("emit");
    if (form.tag === "emit") expect(form.text).toContain("Unknown command");
  });

  test("whitespace is trimmed", () => {
    const form = parseInput("  hello  ");
    expect(form.tag).toBe("think");
    if (form.tag === "think") expect(form.input).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// eval_ tests — direct form evaluation
// ---------------------------------------------------------------------------

describe("eval_ — form evaluation", () => {
  test("Nil does nothing", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(Nil, world, fx);
    expect(events).toHaveLength(0);
  });

  test("Done calls complete", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(Done("all done"), world, fx);
    expect(events).toEqual([{ type: "complete", summary: "all done" }]);
  });

  test("Emit outputs text and evaluates then", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, streamedText } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(Emit("hello", Nil), world, fx);
    expect(streamedText).toEqual(["hello"]);
  });

  test("Seq evaluates forms in order", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, streamedText } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(Seq(Emit("a", Nil), Emit("b", Nil)), world, fx);
    expect(streamedText).toEqual(["a", "b"]);
  });

  test("Remember calls fx.remember", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(Remember("fact", Nil), world, fx);
    expect(events).toEqual([{ type: "remember", content: "fact" }]);
  });

  test("Forget calls fx.forget", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(Forget("old", Nil), world, fx);
    expect(events).toEqual([{ type: "forget", content: "old" }]);
  });

  test("Confirm calls fx.confirm and continues", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events, streamedText } = createRecordingFx({ confirmResult: true });
    const world = mkWorld(convo, registry);

    const form = Confirm("rm -rf /", (ok) => Emit(ok ? "approved" : "denied", Nil));
    await eval_(form, world, fx);

    expect(events.find(e => e.type === "confirm")).toBeTruthy();
    expect(streamedText).toEqual(["approved"]);
  });

  test("Confirm denied path", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, streamedText } = createRecordingFx({ confirmResult: false });
    const world = mkWorld(convo, registry);

    const form = Confirm("danger", (ok) => Emit(ok ? "yes" : "no", Nil));
    await eval_(form, world, fx);
    expect(streamedText).toEqual(["no"]);
  });

  test("Ask calls fx.ask and continues", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, streamedText } = createRecordingFx({ askAnswer: "42" });
    const world = mkWorld(convo, registry);

    const form = Ask("What is the answer?", (answer) => Emit(`Got: ${answer}`, Nil));
    await eval_(form, world, fx);
    expect(streamedText).toEqual(["Got: 42"]);
  });

  test("Refresh calls fx.refreshSystem", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(Refresh(), world, fx);
    expect(events).toEqual([{ type: "system_refreshed" }]);
  });

  test("Install calls fx.installTool", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(Install("https://example.com/tool.ts"), world, fx);
    expect(events.some(e => e.type === "install")).toBe(true);
  });

  test("ListTools calls fx.listTools", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, streamedText } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await eval_(ListTools(), world, fx);
    expect(streamedText).toEqual(["tool list"]);
  });

  test("Reboot calls fx.reboot", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await expect(eval_(Reboot("test"), world, fx)).rejects.toThrow("reboot: test");
  });

  test("Spawn calls fx.spawn and continues", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events, streamedText } = createRecordingFx({
      spawnResult: { success: true, summary: "subagent done", exitCode: 0, stdout: "", stderr: "" },
    });
    const world = mkWorld(convo, registry);

    const form = Spawn("do stuff", (r) => Emit(r.summary, Nil));
    await eval_(form, world, fx);

    expect(events.some(e => e.type === "spawn")).toBe(true);
    expect(streamedText).toEqual(["subagent done"]);
  });

  test("abort signal stops eval_ immediately", async () => {
    const provider = new MockProvider([]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const abort = new AbortController();
    abort.abort();
    const world = mkWorld(convo, registry, abort.signal);

    await expect(eval_(Emit("should not emit", Nil), world, fx)).rejects.toThrow(AbortError);
  });
});

// ---------------------------------------------------------------------------
// run() integration tests — agent loop with JSON tool calls
// ---------------------------------------------------------------------------

describe("run — agent loop", () => {
  test("text-only response — no tool calls", async () => {
    const provider = new MockProvider([
      { text: "Hello, world!" },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events, streamedText } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("hi", world, fx);

    expect(streamedText).toEqual(["Hello, world!"]);
    expect(events).toEqual([
      { type: "stream_chunk", text: "Hello, wor" },
      { type: "stream_chunk", text: "ld!" },
      { type: "stream_done" },
    ]);
  });

  test("tool execution error returns error result to LLM", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "Fail", { msg: "kaboom" })],
      },
      { text: "I see the error." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events, streamedText } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("trigger fail", world, fx);

    const toolDone = events.find(e => e.type === "tool_done" && e.name === "Fail") as any;
    expect(toolDone.success).toBe(false);
    expect(toolDone.output).toContain("kaboom");

    expect(streamedText[streamedText.length - 1]).toBe("I see the error.");
  });

  test("AskUser tool handled via fx.ask, not normal execution", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "AskUser", { question: "What color?" })],
      },
      { text: "Great choice!" },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx({ askAnswer: "blue" });
    const world = mkWorld(convo, registry);

    await run("ask something", world, fx);

    const askEvent = events.find(e => e.type === "ask") as any;
    expect(askEvent.question).toBe("What color?");
  });

  test("ManageContext tool handled via fx.manageContext", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "ManageContext", { instructions: "prune old stuff" })],
      },
      { text: "Context cleaned." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("clean up", world, fx);

    const toolDone = events.find(e => e.type === "tool_done" && e.name === "ManageContext") as any;
    expect(toolDone.success).toBe(true);
  });

  test("Reload tool triggers system refresh", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "Reload", {})],
      },
      { text: "Reloaded." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("reload", world, fx);

    expect(events.some(e => e.type === "system_refreshed")).toBe(true);
  });

  test("tool with askPermission — approved", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "DangerTool", { action: "destroy" })],
      },
      { text: "Done." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx({ confirmResult: true });
    const world = mkWorld(convo, registry);

    await run("do dangerous", world, fx);

    const confirmEvent = events.find(e => e.type === "confirm") as any;
    expect(confirmEvent.command).toBe("Will destroy things");

    const toolDone = events.find(e => e.type === "tool_done" && e.name === "DangerTool") as any;
    expect(toolDone.success).toBe(true);
    expect(toolDone.output).toBe("ok");
  });

  test("tool with askPermission — denied", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "DangerTool", { action: "destroy" })],
      },
      { text: "OK, cancelled." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx({ confirmResult: false });
    const world = mkWorld(convo, registry);

    await run("do dangerous", world, fx);

    const toolDone = events.find(e => e.type === "tool_done" && e.name === "DangerTool") as any;
    expect(toolDone.success).toBe(false);
  });

  test("tool with askPermission — safe action skips confirmation", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "DangerTool", { action: "safe_action" })],
      },
      { text: "Done." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("do safe", world, fx);

    expect(events.filter(e => e.type === "confirm")).toHaveLength(0);
    const toolDone = events.find(e => e.type === "tool_done" && e.name === "DangerTool") as any;
    expect(toolDone.success).toBe(true);
  });

  test("Remember tool calls fx.remember", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "Remember", { content: "user prefers dark mode" })],
      },
      { text: "Noted." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("update prefs", world, fx);

    expect(events.some(e => e.type === "remember" && (e as any).content === "user prefers dark mode")).toBe(true);
  });

  test("Forget tool calls fx.forget", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "Forget", { content: "user prefers light mode" })],
      },
      { text: "Forgotten." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("forget pref", world, fx);

    expect(events.some(e => e.type === "forget" && (e as any).content === "user prefers light mode")).toBe(true);
  });

  test("multiple tool calls — all execute", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          tc("c1", "Echo", { text: "a" }),
          tc("c2", "Echo", { text: "b" }),
          tc("c3", "Echo", { text: "c" }),
        ],
      },
      { text: "Done." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("triple echo", world, fx);

    const starts = events.filter(e => e.type === "tool_start");
    expect(starts).toHaveLength(3);
  });

  test("CompleteTask via JSON stops the loop", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "CompleteTask", { summary: "All done" })],
      },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("finish", world, fx);

    const complete = events.find(e => e.type === "complete") as any;
    expect(complete).toBeTruthy();
    expect(complete.summary).toBe("All done");
  });

  test("CompleteTask with default summary", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "CompleteTask", {})],
      },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("done", world, fx);

    const complete = events.find(e => e.type === "complete") as any;
    expect(complete.summary).toBe("Task complete");
  });

  test("tools are forwarded to provider", async () => {
    const provider = new MockProvider([
      { text: "No tools needed." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("test", world, fx);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools).toBeDefined();
    expect(provider.calls[0].tools!.length).toBeGreaterThan(0);
    expect(provider.calls[0].tools!.some(t => t.function.name === "Echo")).toBe(true);
  });

  test("tool result format includes name and status", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "Echo", { text: "test" })],
      },
      { text: "ok" },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("echo", world, fx);

    // The second call to the provider should have the tool result in messages
    expect(provider.calls).toHaveLength(2);
    const lastMessages = provider.calls[1].messages;
    const lastUserMsg = lastMessages[lastMessages.length - 1];
    expect(lastUserMsg.content).toContain('<tool_result name="Echo" status="success">');
    expect(lastUserMsg.content).toContain("test");
  });

  test("history accumulates across turns", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [tc("c1", "Echo", { text: "step1" })],
      },
      {
        toolCalls: [tc("c2", "Echo", { text: "step2" })],
      },
      { text: "Final." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("multi-step", world, fx);

    const history = convo.getHistory();
    // user (initial), user (result1), user (result2), assistant (final text)
    // Note: tool-call-only responses don't add assistant messages (no text content)
    expect(history.length).toBeGreaterThanOrEqual(3);
  });

  test("abort during tool execution", async () => {
    const abort = new AbortController();
    const provider = new MockProvider([
      {
        toolCalls: [
          tc("c1", "Echo", { text: "a" }),
          tc("c2", "Echo", { text: "b" }),
        ],
      },
    ]);
    const convo = new AIConversation(provider, "m");

    const registry = new ToolRegistry();
    registry.register({
      name: "Echo",
      description: "Echo",
      arguments: [{ name: "text", description: "text" }],
      execute: async (args) => {
        // Abort after first tool call
        abort.abort();
        return args.text ?? "";
      },
    });
    registry.register({
      name: "CompleteTask",
      description: "Complete",
      arguments: [{ name: "summary", description: "s" }],
      execute: async (args) => args.summary ?? "",
    });

    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry, abort.signal);

    await expect(run("test", world, fx)).rejects.toThrow(AbortError);
  });
});
