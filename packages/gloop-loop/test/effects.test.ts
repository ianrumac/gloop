import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
} from "../src/ai/types.js";
import { AIConversation } from "../src/ai/builder.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createEffects } from "../src/defaults/effects.js";
import type { Effects } from "../src/core/core.js";

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

class MockProvider implements AIProvider {
  readonly name = "mock";
  async complete(config: AIRequestConfig): Promise<AIResponse> {
    return { id: "m", model: "m", content: "ok", finishReason: "stop" };
  }
  stream(config: AIRequestConfig): StreamResult {
    const textStream: AsyncIterableIterator<string> = (async function* () {
      yield "ok";
    })();
    return { textStream, toolCalls: Promise.resolve([]), cancel: async () => {} };
  }
}

// ---------------------------------------------------------------------------
// createEffects tests
// ---------------------------------------------------------------------------

describe("createEffects", () => {
  function makeEffects(overrides?: Partial<Parameters<typeof createEffects>[0]>) {
    const provider = new MockProvider();
    const convo = new AIConversation(provider, "m");
    const registry = new ToolRegistry();
    registry.register({
      name: "Echo",
      description: "echo",
      arguments: [{ name: "text", description: "t" }],
      execute: async (a) => a.text ?? "",
    });
    registry.register({
      name: "Ping",
      description: "ping",
      arguments: [],
      execute: async () => "pong",
    });
    return createEffects({ convo, registry, ...overrides });
  }

  test("returns all Effects interface keys", () => {
    const fx = makeEffects();
    const keys: (keyof Effects)[] = [
      "streamChunk", "streamDone", "toolStart", "toolDone",
      "confirm", "ask", "remember", "forget",
      "refreshSystem", "manageContext", "complete",
      "installTool", "listTools", "spawn",
    ];
    for (const key of keys) {
      expect(typeof fx[key]).toBe("function");
    }
  });

  test("onStream override is used for streamChunk", () => {
    const chunks: string[] = [];
    const fx = makeEffects({ onStream: (text) => chunks.push(text) });

    fx.streamChunk("hello");
    fx.streamChunk(" world");

    expect(chunks).toEqual(["hello", " world"]);
  });

  test("streamDone sends newline via stream", () => {
    const chunks: string[] = [];
    const fx = makeEffects({ onStream: (text) => chunks.push(text) });

    fx.streamDone();

    expect(chunks).toEqual(["\n"]);
  });

  test("onToolStatus override is used for toolStart and toolDone", () => {
    const statuses: [string, string][] = [];
    const fx = makeEffects({
      onToolStatus: (name, status) => statuses.push([name, status]),
    });

    fx.toolStart("ReadFile", "/foo.ts");
    fx.toolDone("ReadFile", true, "ok");
    fx.toolDone("Bash", false, "command failed");

    expect(statuses).toEqual([
      ["ReadFile", "/foo.ts"],
      ["ReadFile", "done"],
      ["Bash", "error: command failed"],
    ]);
  });

  test("toolDone truncates error output to 100 chars", () => {
    const statuses: [string, string][] = [];
    const fx = makeEffects({
      onToolStatus: (name, status) => statuses.push([name, status]),
    });

    const longError = "x".repeat(200);
    fx.toolDone("Tool", false, longError);

    const [, status] = statuses[0]!;
    expect(status.length).toBeLessThan(200);
    expect(status).toBe(`error: ${"x".repeat(100)}`);
  });

  test("confirm override is used", async () => {
    let confirmCalled = false;
    const fx = makeEffects({
      confirm: async (cmd) => { confirmCalled = true; return true; },
    });

    const result = await fx.confirm("rm -rf /");
    expect(confirmCalled).toBe(true);
    expect(result).toBe(true);
  });

  test("ask override is used", async () => {
    const fx = makeEffects({
      ask: async (q) => `answer to: ${q}`,
    });

    const result = await fx.ask("what color?");
    expect(result).toBe("answer to: what color?");
  });

  test("remember override is used", async () => {
    let remembered = "";
    const fx = makeEffects({
      remember: async (content) => { remembered = content; },
    });

    await fx.remember("important fact");
    expect(remembered).toBe("important fact");
  });

  test("forget override is used", async () => {
    let forgotten = "";
    const fx = makeEffects({
      forget: async (content) => { forgotten = content; },
    });

    await fx.forget("old fact");
    expect(forgotten).toBe("old fact");
  });

  test("refreshSystem override is used", async () => {
    let refreshed = false;
    const fx = makeEffects({
      refreshSystem: async () => { refreshed = true; },
    });

    await fx.refreshSystem();
    expect(refreshed).toBe(true);
  });

  test("refreshSystem defaults to no-op", async () => {
    const fx = makeEffects();
    // Should not throw
    await fx.refreshSystem();
  });

  test("onComplete override is used", () => {
    let completedWith = "";
    const fx = makeEffects({
      onComplete: (summary) => { completedWith = summary; },
    });

    fx.complete("all done");
    expect(completedWith).toBe("all done");
  });

  test("installTool returns not-available message", async () => {
    const fx = makeEffects();
    const result = await fx.installTool("https://example.com/tool.ts");
    expect(result).toContain("not available");
  });

  test("listTools returns registry tool names", () => {
    const fx = makeEffects();
    const result = fx.listTools();
    expect(result).toContain("Echo");
    expect(result).toContain("Ping");
    expect(result).toContain("2 tools available");
  });

  test("spawn default returns error stub", async () => {
    const fx = makeEffects();
    const result = await fx.spawn("some task");
    expect(result.success).toBe(false);
    expect(result.summary).toContain("not configured");
  });

  test("spawn override is used", async () => {
    const fx = makeEffects({
      spawn: async (task) => ({
        success: true,
        summary: `spawned: ${task}`,
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    });

    const result = await fx.spawn("do thing");
    expect(result.success).toBe(true);
    expect(result.summary).toBe("spawned: do thing");
  });

  test("log is passed through when provided", () => {
    const logs: [string, string][] = [];
    const fx = makeEffects({
      log: (label, content) => logs.push([label, content]),
    });

    fx.log!("TEST", "hello");
    expect(logs).toEqual([["TEST", "hello"]]);
  });

  test("log is undefined when not provided", () => {
    const fx = makeEffects();
    expect(fx.log).toBeUndefined();
  });
});
