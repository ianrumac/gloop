import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  JsonToolCall,
  StreamResult,
} from "../src/ai/types.js";
import { AIConversation } from "../src/ai/builder.js";
import { truncateOutput } from "../src/tools/output.js";
import { ToolRegistry } from "../src/tools/registry.js";
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
  Install,
  ListTools,
  Spawn,
  AbortError,
  normalizeCompactAt,
  type Form,
  type Effects,
  type World,
  type LoopConfig,
} from "../src/core/core.js";

// ---------------------------------------------------------------------------
// Mock provider that returns StreamResult from stream()
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
      finishReason: Promise.resolve(null),
      cancel: async () => {},
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** A classifySpawn hook for testing — recognizes "spawn:task" in Bash calls */
function testClassifySpawn(call: { name: string; args: Record<string, string> }): string | null {
  if (call.name !== "Bash") return null;
  const cmd = call.args.command ?? "";
  if (cmd.startsWith("spawn:")) return cmd.slice(6);
  return null;
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
    const form = toolCallsToForm([{ name: "Echo", args: { text: "hi" } }]);
    expect(form.tag).toBe("invoke");
  });

  test("CompleteTask returns Done", () => {
    const form = toolCallsToForm([{ name: "CompleteTask", args: { summary: "finished" } }]);
    expect(form.tag).toBe("done");
    if (form.tag === "done") expect(form.summary).toBe("finished");
  });

  test("mixed regular + CompleteTask invokes tools first", () => {
    const form = toolCallsToForm([
      { name: "Echo", args: { text: "work" } },
      { name: "CompleteTask", args: { summary: "done" } },
    ]);
    expect(form.tag).toBe("invoke");
    if (form.tag === "invoke") {
      expect(form.calls).toHaveLength(1);
      expect(form.calls[0].name).toBe("Echo");
      const next = form.then([]);
      expect(next.tag).toBe("done");
    }
  });

  test("classifySpawn creates spawn form", () => {
    const form = toolCallsToForm(
      [{ name: "Bash", args: { command: "spawn:fix tests" } }],
      testClassifySpawn,
    );
    expect(form.tag).toBe("spawn");
  });

  test("mixed spawn and regular tools — invoke plain first", () => {
    const form = toolCallsToForm(
      [
        { name: "Echo", args: { text: "work" } },
        { name: "Bash", args: { command: "spawn:subtask" } },
      ],
      testClassifySpawn,
    );
    expect(form.tag).toBe("invoke");
    if (form.tag === "invoke") {
      expect(form.calls).toHaveLength(1);
      expect(form.calls[0].name).toBe("Echo");
    }
  });

  test("without classifySpawn, Bash calls are regular tools", () => {
    const form = toolCallsToForm([
      { name: "Bash", args: { command: "spawn:something" } },
    ]);
    // No classifySpawn → treated as regular Invoke
    expect(form.tag).toBe("invoke");
  });

  test("CompleteTask with default summary", () => {
    const form = toolCallsToForm([{ name: "CompleteTask", args: {} }]);
    expect(form.tag).toBe("done");
    if (form.tag === "done") expect(form.summary).toBe("Task complete");
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

  test("/skills becomes Emit with listing", () => {
    const skills = [
      { name: "demo", description: "Demo skill", dir: "/x", body: "x" },
    ];
    const form = parseInput("/skills", { skills });
    expect(form.tag).toBe("emit");
    if (form.tag === "emit") {
      expect(form.text).toContain("demo");
      expect(form.text).toContain("Demo skill");
    }
  });

  test("/skill <name> becomes Think with skill body", () => {
    const skills = [
      { name: "web-design-guidelines", description: "d", dir: "/x", body: "Review UI for $ARGUMENTS" },
    ];
    const form = parseInput("/skill web-design-guidelines src/App.tsx", { skills });
    expect(form.tag).toBe("think");
    if (form.tag === "think") {
      expect(form.input).toContain("Review UI");
      expect(form.input).toContain("src/App.tsx");
    }
  });

  test("/skill without args becomes Emit usage", () => {
    const form = parseInput("/skill", { skills: [] });
    expect(form.tag).toBe("emit");
    if (form.tag === "emit") expect(form.text).toContain("Usage");
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

  test("input starting with / that is not a command or skill becomes Think", () => {
    for (const input of ["/foo", "/etc/hosts looks wrong, can you check it?", "/usr/bin/env node"]) {
      const form = parseInput(input);
      expect(form.tag).toBe("think");
      if (form.tag === "think") expect(form.input).toBe(input);
    }
    // Known commands are still commands, with or without skills loaded.
    expect(parseInput("/tools").tag).toBe("list-tools");
    expect(parseInput("/install x").tag).toBe("install");
  });

  test("whitespace is trimmed", () => {
    const form = parseInput("  hello  ");
    expect(form.tag).toBe("think");
    if (form.tag === "think") expect(form.input).toBe("hello");
  });

  test("/skill-name resolves to Think with skill body", () => {
    const skills = [
      {
        name: "deploy",
        description: "Deploy",
        dir: "/x/deploy",
        body: "Deploy steps:\n1. Test",
      },
    ];
    const form = parseInput("/deploy", { skills });
    expect(form.tag).toBe("think");
    if (form.tag === "think") expect(form.input).toContain("Deploy steps");
  });

  test("skill overrides built-in when names collide", () => {
    const skills = [
      {
        name: "install",
        description: "Custom install skill",
        dir: "/x/install",
        body: "skill install body",
      },
    ];
    const form = parseInput("/install", { skills });
    expect(form.tag).toBe("think");
    if (form.tag === "think") expect(form.input).toBe("skill install body");
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
// run() integration tests
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
      { toolCalls: [tc("c1", "Fail", { msg: "kaboom" })] },
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

  test("AskUser tool handled via fx.ask", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "AskUser", { question: "What color?" })] },
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
      { toolCalls: [tc("c1", "ManageContext", { instructions: "prune old stuff" })] },
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
      { toolCalls: [tc("c1", "Reload", {})] },
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
      { toolCalls: [tc("c1", "DangerTool", { action: "destroy" })] },
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
      { toolCalls: [tc("c1", "DangerTool", { action: "destroy" })] },
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
      { toolCalls: [tc("c1", "CompleteTask", { summary: "All done" })] },
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

  test("tools are forwarded to provider", async () => {
    const provider = new MockProvider([{ text: "No tools needed." }]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("test", world, fx);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools).toBeDefined();
    expect(provider.calls[0].tools!.some(t => t.function.name === "Echo")).toBe(true);
  });

  test("unknown tool returns error and continues", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "NonExistent", { x: "y" })] },
      { text: "Recovered." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events, streamedText } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("call unknown", world, fx);

    const toolDone = events.find(e => e.type === "tool_done" && e.name === "NonExistent") as any;
    expect(toolDone).toBeTruthy();
    expect(toolDone.success).toBe(false);
    expect(toolDone.output).toContain("Unknown tool");

    expect(streamedText[streamedText.length - 1]).toBe("Recovered.");
  });

  test("abort during tool execution", async () => {
    const abort = new AbortController();
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Echo", { text: "a" }), tc("c2", "Echo", { text: "b" })] },
    ]);
    const convo = new AIConversation(provider, "m");

    const registry = new ToolRegistry();
    registry.register({
      name: "Echo",
      description: "Echo",
      arguments: [{ name: "text", description: "text" }],
      execute: async (args) => {
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

  test("auto-prune triggers after configured interval", async () => {
    const responses: MockResponse[] = [];
    for (let i = 0; i < 11; i++) {
      responses.push({ toolCalls: [tc(`c${i}`, "Echo", { text: `${i}` })] });
    }
    responses.push({ text: "Done." });

    const provider = new MockProvider(responses);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    // Use a smaller interval for testing
    await run("trigger auto-prune", world, fx, { contextPruneInterval: 10 });

    const manageStarts = events.filter(
      e => e.type === "tool_start" && e.name === "ManageContext"
    );
    expect(manageStarts.length).toBeGreaterThanOrEqual(1);
  });

  test("log callback receives LLM input/output", async () => {
    const provider = new MockProvider([{ text: "response" }]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const logs: [string, string][] = [];
    const { fx, events } = createRecordingFx();
    fx.log = (label, content) => logs.push([label, content]);
    const world = mkWorld(convo, registry);

    await run("input", world, fx);

    expect(logs.some(([l]) => l === "LLM_INPUT")).toBe(true);
    expect(logs.some(([l]) => l === "LLM_OUTPUT")).toBe(true);
  });

  test("Bash rm command triggers confirmation", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "Bash",
      description: "Execute shell command",
      arguments: [{ name: "command", description: "command" }],
      execute: async (args) => `ran: ${args.command}`,
    });
    registry.register({
      name: "CompleteTask",
      description: "Complete",
      arguments: [{ name: "summary", description: "s" }],
      execute: async (args) => args.summary ?? "",
    });

    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Bash", { command: "rm -rf /tmp/stuff" })] },
      { text: "Cleaned." },
    ]);
    const convo = new AIConversation(provider, "m");
    const { fx, events } = createRecordingFx({ confirmResult: true });
    const world = mkWorld(convo, registry);

    await run("clean up", world, fx);

    const confirmEvent = events.find(e => e.type === "confirm") as any;
    expect(confirmEvent).toBeTruthy();
    expect(confirmEvent.command).toContain("rm -rf");
  });
});

// ---------------------------------------------------------------------------
// Native tool messages, iteration cap, idle timeout
// ---------------------------------------------------------------------------

describe("native tool-call history", () => {
  test("assistant toolCalls and role:tool responses are recorded in history", async () => {
    const provider = new MockProvider([
      { text: "Let me echo that.", toolCalls: [tc("c1", "Echo", { text: "hi" })] },
      { text: "Done echoing." },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("echo hi", world, fx);

    const h = convo.getHistory();
    // [user, assistant(text+toolCalls), tool, assistant(text)]
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(h[1]!.content).toBe("Let me echo that.");
    expect(h[1]!.toolCalls).toEqual([tc("c1", "Echo", { text: "hi" })]);
    expect(h[2]!.toolCallId).toBe("c1");
    expect(h[2]!.content).toBe("hi");
    // No synthetic user message carrying <tool_result>.
    expect(h.some((m) => m.role === "user" && m.content.includes("<tool_result"))).toBe(false);
  });

  test("tools-only response still records the assistant turn", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Echo", { text: "silent" })] },
      { text: "ok" },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("go", world, fx);

    const h = convo.getHistory();
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(h[1]!.content).toBe("");
    expect(h[1]!.toolCalls?.length).toBe(1);
  });

  test("second LLM request contains the tool response messages", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Echo", { text: "ping" })] },
      { text: "pong" },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("go", world, fx);

    expect(provider.calls.length).toBe(2);
    const second = provider.calls[1]!.messages;
    expect(second.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(true);
    expect(second.some((m) => m.role === "assistant" && m.toolCalls?.length === 1)).toBe(true);
    // The continuation adds NO new user message.
    expect(second.filter((m) => m.role === "user").length).toBe(1);
  });

  test("failed tool results are recorded with an Error prefix", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Fail", { msg: "kaboom" })] },
      { text: "noted" },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("go", world, fx);

    const toolMsg = convo.getHistory().find((m) => m.role === "tool");
    expect(toolMsg!.content.startsWith("Error:")).toBe(true);
    expect(toolMsg!.content).toContain("kaboom");
  });

  test("mixed tool + CompleteTask answers every tool call id", async () => {
    const provider = new MockProvider([
      { toolCalls: [
        tc("c1", "Echo", { text: "last one" }),
        tc("c2", "CompleteTask", { summary: "all done" }),
      ] },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx, events } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("finish", world, fx);

    expect(events.some((e) => e.type === "complete")).toBe(true);
    const h = convo.getHistory();
    const toolIds = h.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(toolIds.sort()).toEqual(["c1", "c2"]);
  });

  test("calls without provider ids fall back to user-message results", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "", type: "function", function: { name: "Echo", arguments: '{"text":"legacy"}' } }] },
      { text: "ok" },
    ]);
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await run("go", world, fx);

    const h = convo.getHistory();
    expect(h.some((m) => m.role === "tool")).toBe(false);
    expect(h.some((m) => m.role === "user" && m.content.includes("<tool_result"))).toBe(true);
  });
});

describe("loop guards", () => {
  test("maxIterations stops a runaway tool loop", async () => {
    // Provider that ALWAYS responds with another tool call.
    const provider: AIProvider = {
      name: "runaway",
      complete: async () => { throw new Error("unused"); },
      stream: () => ({
        textStream: (async function* () {})(),
        toolCalls: Promise.resolve([tc(`c${Math.random()}`, "Echo", { text: "again" })]),
        finishReason: Promise.resolve("tool_calls" as const),
        cancel: async () => {},
      }),
    };
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await expect(run("loop forever", world, fx, { maxIterations: 5 }))
      .rejects.toThrow(/exceeded 5 LLM calls/);
  });

  test("llmIdleTimeoutMs cancels a hung stream", async () => {
    let cancelled = false;
    const provider: AIProvider = {
      name: "hung",
      complete: async () => { throw new Error("unused"); },
      stream: () => ({
        textStream: (async function* () {
          await new Promise(() => {}); // never yields
        })(),
        toolCalls: new Promise(() => {}),
        finishReason: new Promise(() => {}),
        cancel: async () => { cancelled = true; },
      }),
    };
    const convo = new AIConversation(provider, "m");
    const registry = createTestRegistry();
    const { fx } = createRecordingFx();
    const world = mkWorld(convo, registry);

    await expect(run("hang", world, fx, { llmIdleTimeoutMs: 20 }))
      .rejects.toThrow(/no output for 20ms/);
    expect(cancelled).toBe(true);
  });
});


describe("evalInvoke — spawn-classified calls", () => {
  test("a spawn-classified call is executed through fx.spawn and its result is a tool result the model sees", async () => {
    const { fx, events } = createRecordingFx({
      spawnResult: { success: true, summary: "child says hi", exitCode: 0, stdout: "", stderr: "" },
    });
    const provider = new MockProvider([
      { toolCalls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "spawn:child task" }) } }] },
      { text: "thanks" },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "Bash", description: "", arguments: [{ name: "command", description: "" }], execute: async () => "ran for real" });
    const world = mkWorld(new AIConversation(provider, "m"), registry);
    await run("go", world, fx, { classifySpawn: testClassifySpawn });

    expect(events.filter((e) => e.type === "spawn").map((e) => (e as { task: string }).task)).toEqual(["child task"]);
    expect(events.some((e) => e.type === "tool_start" && (e as { name: string }).name === "Bash")).toBe(true);
    const h = world.convo.getHistory();
    const toolMsg = h.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe("c1");
    expect(toolMsg?.content).toContain("child says hi");
    // The next LLM call saw the subagent's result in history — no empty user turn.
    expect(h.some((m) => m.role === "user" && m.content === "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review regressions — interpreter boundary
// ---------------------------------------------------------------------------

/** A recording fx that also keeps tool_start / tool_done with their order. */
function toolTrace(fx: Effects): string[] {
  const trace: string[] = [];
  const start = fx.toolStart, done = fx.toolDone;
  fx.toolStart = (name, ...rest) => { trace.push(`start:${name}`); start(name, ...rest); };
  fx.toolDone = (name, ok, out) => { trace.push(`done:${name}:${ok}`); done(name, ok, out); };
  return trace;
}

describe("truncateOutput", () => {
  test("keeps head and tail around a marker; short text and max<=0 pass through", () => {
    const text = "a".repeat(50) + "b".repeat(100) + "c".repeat(50);
    const out = truncateOutput(text, 100);
    expect(out.startsWith("a".repeat(50))).toBe(true);
    expect(out.endsWith("c".repeat(50))).toBe(true);
    expect(out).toContain("[100 characters omitted — output capped at 100; narrow the command or read a range]");
    expect(truncateOutput("short", 100)).toBe("short");
    expect(truncateOutput(text, 0)).toBe(text);
  });
});

describe("tool boundary regressions", () => {
  test("a tool error classified fatal propagates out of the turn and is not retried", async () => {
    class Fatal extends Error {}
    let runs = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "Boom", description: "", arguments: [], retryable: true,
      execute: async () => { runs += 1; throw new Fatal("reboot"); },
    });
    const provider = new MockProvider([{ toolCalls: [tc("c1", "Boom", {})] }, { text: "never" }]);
    const world = mkWorld(new AIConversation(provider, "m"), registry);
    const { fx } = createRecordingFx();
    const config: LoopConfig = { isFatal: (e) => e instanceof Fatal, retry: { tool: { attempts: 3, backoffMs: 1 } } };
    await expect(run("go", world, fx, config)).rejects.toBeInstanceOf(Fatal);
    expect(runs).toBe(1);
    expect(provider.calls.length).toBe(1);
    // History stays provider-valid: the call is answered.
    const tool = world.convo.getHistory().find((m) => m.role === "tool");
    expect(tool?.toolCallId).toBe("c1");
  });

  test("denied and unknown tools emit tool_start before tool_done", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DangerTool", { action: "destroy" }), tc("c2", "Nope", {})] },
      { text: "ok" },
    ]);
    const world = mkWorld(new AIConversation(provider, "m"), createTestRegistry());
    const { fx } = createRecordingFx({ confirmResult: false });
    const trace = toolTrace(fx);
    await run("go", world, fx);
    expect(trace).toEqual(["start:DangerTool", "done:DangerTool:false", "start:Nope", "done:Nope:false"]);
  });

  test("malformed tool-call JSON is not executed; the model is told why (and about truncation)", async () => {
    let ran = false;
    const registry = new ToolRegistry();
    registry.register({
      name: "Bash", description: "", arguments: [{ name: "command", description: "" }],
      execute: async () => { ran = true; return "ran"; },
    });
    const bad: JsonToolCall = { id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"echo hi' } };
    const provider = new MockProvider([{ toolCalls: [bad] }, { text: "ok" }]);
    // finishReason "length" — the response was cut off by max_tokens.
    const orig = provider.stream.bind(provider);
    let first = true;
    provider.stream = (c) => {
      const r = orig(c);
      if (first) { first = false; return { ...r, finishReason: Promise.resolve("length" as const) }; }
      return r;
    };
    const world = mkWorld(new AIConversation(provider, "m"), registry);
    const { fx, events } = createRecordingFx();
    await run("go", world, fx);
    expect(ran).toBe(false);
    const tool = world.convo.getHistory().find((m) => m.role === "tool")!;
    expect(tool.content).toContain("not valid JSON");
    expect(tool.content).toContain("max_tokens");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_done", name: "Bash", success: false }));
  });

  test("tool output is capped centrally (head + tail), per-tool override and 0 disable it", async () => {
    const big = "H".repeat(100) + "x".repeat(10_000) + "T".repeat(100);
    const registry = new ToolRegistry();
    registry.register({ name: "Big", description: "", arguments: [], execute: async () => big });
    registry.register({ name: "Wide", description: "", arguments: [], maxOutputChars: 0, execute: async () => big });
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Big", {}), tc("c2", "Wide", {})] },
      { text: "ok" },
    ]);
    const world = mkWorld(new AIConversation(provider, "m"), registry);
    await run("go", world, createRecordingFx().fx, { maxToolOutputChars: 1000 });
    const [capped, wide] = world.convo.getHistory().filter((m) => m.role === "tool");
    expect(capped!.content.startsWith("H".repeat(100))).toBe(true);
    expect(capped!.content.endsWith("T".repeat(100))).toBe(true);
    expect(capped!.content).toContain("characters omitted — output capped at 1000");
    expect(capped!.content.length).toBeLessThan(1200);
    expect(wide!.content).toBe(big);
  });

  test("tools receive the turn's signal, and an interrupt unwinds a tool that ignores it", async () => {
    let seen: AbortSignal | undefined;
    const registry = new ToolRegistry();
    registry.register({
      name: "Slow", description: "", arguments: [],
      execute: async (_a, ctx) => { seen = ctx?.signal; await new Promise((r) => setTimeout(r, 2000)); return "late"; },
    });
    registry.register({ name: "Echo", description: "", arguments: [], execute: async () => "fast" });
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Echo", {}), tc("c2", "Slow", {}), tc("c3", "Echo", {})] },
    ]);
    const ac = new AbortController();
    const world = mkWorld(new AIConversation(provider, "m"), registry, ac.signal);
    const { fx } = createRecordingFx();
    const trace = toolTrace(fx);
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    await expect(run("go", world, fx)).rejects.toBeInstanceOf(AbortError);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seen).toBe(ac.signal);
    expect(trace).toEqual(["start:Echo", "done:Echo:true", "start:Slow", "done:Slow:false"]);
    // The completed call keeps its result; the rest are answered "interrupted".
    const tools = world.convo.getHistory().filter((m) => m.role === "tool");
    expect(tools.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(tools[0]!.content).toBe("fast");
    expect(tools[1]!.content).toContain("Interrupted");
    expect(tools[2]!.content).toContain("Interrupted");
  });

  test("spawn handlers receive the turn's signal", async () => {
    let call: { signal?: AbortSignal } | undefined;
    const provider = new MockProvider([{ toolCalls: [tc("c1", "Bash", { command: "spawn:job" })] }, { text: "ok" }]);
    const registry = new ToolRegistry();
    registry.register({ name: "Bash", description: "", arguments: [{ name: "command", description: "" }], execute: async () => "" });
    const ac = new AbortController();
    const world = mkWorld(new AIConversation(provider, "m"), registry, ac.signal);
    const { fx } = createRecordingFx();
    fx.spawn = async (_task, c) => { call = c; return { success: true, summary: "ok", exitCode: 0, stdout: "", stderr: "" }; };
    await run("go", world, fx, { classifySpawn: testClassifySpawn });
    expect(call?.signal).toBe(ac.signal);
  });

  test("a throwing remember / failing ManageContext become failed tool results, not failed turns", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Remember", { content: "x" }), tc("c2", "ManageContext", { instructions: "prune" })] },
      { text: "ok" },
    ]);
    const world = mkWorld(new AIConversation(provider, "m"), createTestRegistry());
    const { fx } = createRecordingFx();
    fx.remember = async () => { throw new Error("disk full"); };
    fx.manageContext = async () => { throw new Error("strategy broke"); };
    await run("go", world, fx);
    const tools = world.convo.getHistory().filter((m) => m.role === "tool");
    expect(tools[0]!.content).toContain("disk full");
    expect(tools[1]!.content).toContain("strategy broke");
    expect(provider.calls.length).toBe(2); // the turn went on
  });

  test("a failing auto-prune is reported and the turn continues", async () => {
    const provider = new MockProvider([{ toolCalls: [tc("c1", "Echo", { text: "a" })] }, { text: "done" }]);
    const world = mkWorld(new AIConversation(provider, "m"), createTestRegistry());
    const { fx, events } = createRecordingFx();
    fx.manageContext = async () => { throw new Error("strategy broke"); };
    await run("go", world, fx, { contextPruneInterval: 1 });
    expect(events).toContainEqual({ type: "tool_done", name: "ManageContext", success: false, output: "Context management failed: strategy broke" });
    expect(provider.calls.length).toBe(2);
  });
});

describe("streaming regressions", () => {
  test('"" heartbeats keep the idle timer alive but are not output', async () => {
    const provider: AIProvider = {
      name: "hb",
      complete: async () => { throw new Error("unused"); },
      stream: () => ({
        textStream: (async function* () {
          for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 25)); yield ""; }
          yield "hi";
        })(),
        toolCalls: Promise.resolve([]),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ promptTokens: 7, completionTokens: 1, totalTokens: 8 }),
        cancel: async () => {},
      }),
    };
    const world = mkWorld(new AIConversation(provider, "m"), new ToolRegistry());
    const { fx, events } = createRecordingFx();
    await run("go", world, fx, { llmIdleTimeoutMs: 60 });
    expect(events.filter((e) => e.type === "stream_chunk")).toEqual([{ type: "stream_chunk", text: "hi" }]);
    expect(world.convo.getHistory().at(-1)).toEqual({ role: "assistant", content: "hi" });
    expect(world.lastUsage).toEqual({ promptTokens: 7, completionTokens: 1, totalTokens: 8 });
  });
});

describe("compactAtTokens — range", () => {
  test("normalizeCompactAt: number, range, and invalid ranges", () => {
    expect(normalizeCompactAt(undefined)).toEqual({ trigger: 0 });
    expect(normalizeCompactAt(1000)).toEqual({ trigger: 1000 });
    expect(normalizeCompactAt({ trigger: 1000 })).toEqual({ trigger: 1000 });
    expect(normalizeCompactAt({ trigger: 1000, target: 600 })).toEqual({ trigger: 1000, target: 600 });
    expect(() => normalizeCompactAt({ trigger: 1000, target: 1000 })).toThrow("must be below");
    expect(() => normalizeCompactAt({ trigger: 1000, target: 2000 })).toThrow("must be below");
    expect(() => normalizeCompactAt({ trigger: 1000, target: -1 })).toThrow("target");
    expect(() => normalizeCompactAt(-5)).toThrow("non-negative");
  });

  test("a token-triggered run passes targetTokens; an interval-triggered one does not", async () => {
    const infos: Array<{ tokens?: number; targetTokens?: number } | undefined> = [];
    const big = "x".repeat(4000);
    for (const config of [
      { compactAtTokens: { trigger: 500, target: 200 } },
      { compactAtTokens: { trigger: 1_000_000, target: 200 }, contextPruneInterval: 1 },
    ] satisfies LoopConfig[]) {
      const provider = new MockProvider([{ toolCalls: [tc("c1", "Echo", { text: big })] }, { text: "done" }]);
      const world = mkWorld(new AIConversation(provider, "m"), createTestRegistry());
      const { fx } = createRecordingFx();
      fx.manageContext = async (_i, _t, info) => { infos.push(info); return "ok"; };
      await run("go", world, fx, config);
    }
    expect(infos).toHaveLength(2);
    expect(infos[0]!.targetTokens).toBe(200);
    expect(infos[0]!.tokens!).toBeGreaterThanOrEqual(500);
    expect(infos[1]!.targetTokens).toBeUndefined();
  });
});
