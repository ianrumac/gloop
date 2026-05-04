/**
 * Interceptor tests — chain ordering, input/output mutation, short-circuit,
 * retry, error rethrow.  Drives a real `AgentLoop` with a mock provider so
 * we exercise the actual wiring through `world.interceptors` rather than
 * the helper in isolation.
 */

import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  JsonToolCall,
} from "../src/ai/types.js";
import { AgentLoop } from "../src/agent.js";
import type {
  Interceptor,
  LlmCallContext,
  LlmCallResult,
  ToolCallContext,
  ToolCallResult,
} from "../src/interceptors.js";
import { chain } from "../src/interceptors.js";

// ---------------------------------------------------------------------------
// Mock provider (mirrors the one in agent.test.ts)
// ---------------------------------------------------------------------------

interface MockResponse {
  text?: string;
  toolCalls?: JsonToolCall[];
}

class MockProvider implements AIProvider {
  readonly name = "mock";
  private responses: MockResponse[];
  private callIndex = 0;
  readonly seenInputs: string[] = [];

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async complete(_config: AIRequestConfig): Promise<AIResponse> {
    const r = this.responses[this.callIndex++] ?? {};
    return {
      id: "mock",
      model: "mock",
      content: r.text ?? null,
      finishReason: r.toolCalls?.length ? "tool_calls" : "stop",
      ...(r.toolCalls && { toolCalls: r.toolCalls }),
    };
  }

  stream(config: AIRequestConfig): StreamResult {
    // Capture the most recent user message for assertions.
    const lastUser = [...config.messages].reverse().find((m) => m.role === "user");
    if (lastUser) this.seenInputs.push(lastUser.content);

    const r = this.responses[this.callIndex++] ?? {};
    const text = r.text ?? "";
    const textStream = (async function* () {
      for (let i = 0; i < text.length; i += 10) yield text.slice(i, i + 10);
    })();
    return {
      textStream,
      toolCalls: Promise.resolve(r.toolCalls ?? []),
      finishReason: Promise.resolve(null),
      cancel: async () => {},
    };
  }
}

const tc = (id: string, name: string, args: Record<string, string>): JsonToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

// ---------------------------------------------------------------------------
// `chain` — direct unit tests on the helper
// ---------------------------------------------------------------------------

describe("chain helper", () => {
  test("runs interceptors outermost-to-innermost, then the final handler", async () => {
    const order: string[] = [];

    const run = chain<{ v: number }, number>(
      [
        async (ctx, next) => {
          order.push("a:before");
          const r = await next(ctx);
          order.push("a:after");
          return r + 100;
        },
        async (ctx, next) => {
          order.push("b:before");
          const r = await next(ctx);
          order.push("b:after");
          return r + 10;
        },
      ],
      async (ctx) => {
        order.push("final");
        return ctx.v;
      },
    );

    const result = await run({ v: 1 });
    // Final returns 1, b adds 10, a adds 100 → 111
    expect(result).toBe(111);
    expect(order).toEqual(["a:before", "b:before", "final", "b:after", "a:after"]);
  });

  test("input mutation: rewrite ctx before next() and the final handler sees it", async () => {
    const seen: string[] = [];
    const run = chain<{ msg: string }, string>(
      [
        async (ctx, next) => next({ ...ctx, msg: ctx.msg.toUpperCase() }),
      ],
      async (ctx) => {
        seen.push(ctx.msg);
        return ctx.msg;
      },
    );

    const result = await run({ msg: "hello" });
    expect(result).toBe("HELLO");
    expect(seen).toEqual(["HELLO"]);
  });

  test("short-circuit: returning without calling next skips the rest of the chain", async () => {
    let finalRan = false;
    const run = chain<{ x: number }, string>(
      [
        async (ctx) => `short:${ctx.x}`,
        async (_ctx, next) => {
          throw new Error("should not be called");
        },
      ],
      async () => {
        finalRan = true;
        return "final";
      },
    );

    const result = await run({ x: 42 });
    expect(result).toBe("short:42");
    expect(finalRan).toBe(false);
  });

  test("retry: calling next() twice re-runs the chain from the same position", async () => {
    let finalCalls = 0;
    const run = chain<{}, number>(
      [
        async (ctx, next) => {
          // First call fails, second succeeds — both go through the inner final handler.
          try {
            return await next(ctx);
          } catch {
            return next(ctx);
          }
        },
      ],
      async () => {
        finalCalls += 1;
        if (finalCalls === 1) throw new Error("transient");
        return finalCalls;
      },
    );

    const result = await run({});
    expect(result).toBe(2);
    expect(finalCalls).toBe(2);
  });

  test("errors propagate when not caught", async () => {
    const run = chain<{}, never>(
      [],
      async () => {
        throw new Error("boom");
      },
    );
    await expect(run({})).rejects.toThrow("boom");
  });

  test("zero interceptors: returns the final handler directly", async () => {
    const run = chain<{ x: number }, number>([], async (ctx) => ctx.x * 2);
    expect(await run({ x: 21 })).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Wiring tests — interceptors plumbed through AgentLoop
// ---------------------------------------------------------------------------

describe("AgentLoop interceptors", () => {
  test("llmCall interceptor sees model + history + tools and can rewrite input", async () => {
    let capturedCtx: LlmCallContext | null = null;
    const provider = new MockProvider([{ text: "ok" }]);

    const redact: Interceptor = {
      name: "redact",
      llmCall: async (ctx, next) => {
        capturedCtx = ctx;
        return next({ ...ctx, input: ctx.input.replace(/secret/g, "[redacted]") });
      },
    };

    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
      interceptors: [redact],
    });

    await agent.sendSync("the secret is safe");
    await agent.stop();

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.model).toBe("test-model");
    expect(capturedCtx!.input).toBe("the secret is safe");
    // Provider received the rewritten input.
    expect(provider.seenInputs[0]).toBe("the [redacted] is safe");
  });

  test("llmCall interceptor can short-circuit (no provider call)", async () => {
    const provider = new MockProvider([]);
    let providerCalled = false;
    const tracker = new Proxy(provider, {
      get: (target, prop) => {
        if (prop === "stream" || prop === "complete") providerCalled = true;
        return Reflect.get(target, prop);
      },
    });

    const fakeReply: Interceptor = {
      llmCall: async () => ({ text: "cached", toolCalls: [], finishReason: "stop" }) as LlmCallResult,
    };

    const agent = new AgentLoop({
      provider: tracker,
      model: "m",
      tools: [],
      interceptors: [fakeReply],
    });

    await agent.sendSync("anything");
    await agent.stop();

    expect(providerCalled).toBe(false);
  });

  test("toolCall interceptor sees args and can transform the result", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Echo", { text: "raw" })] },
      { text: "done" },
    ]);

    const captured: ToolCallContext[] = [];
    const decorate: Interceptor = {
      toolCall: async (ctx, next) => {
        captured.push(ctx);
        const result = await next(ctx);
        if (result.success) {
          return { success: true, output: `[wrapped] ${result.output}` };
        }
        return result;
      },
    };

    const seenResults: ToolCallResult[] = [];
    const observer: Interceptor = {
      toolCall: async (ctx, next) => {
        const r = await next(ctx);
        seenResults.push(r);
        return r;
      },
    };

    const agent = new AgentLoop({
      provider,
      model: "m",
      tools: [
        {
          name: "Echo",
          description: "echo",
          arguments: [{ name: "text", description: "text" }],
          execute: async (args) => `echo: ${args.text}`,
        },
      ],
      interceptors: [observer, decorate], // observer is outermost — sees final wrapped output
    });

    await agent.sendSync("call echo");
    await agent.stop();

    expect(captured.length).toBe(1);
    expect(captured[0]!.name).toBe("Echo");
    expect(captured[0]!.args).toEqual({ text: "raw" });
    // Outer observer sees the wrapped result.
    expect(seenResults[0]?.success).toBe(true);
    expect((seenResults[0] as { output: string }).output).toBe("[wrapped] echo: raw");
  });

  test("toolCall interceptor can deny via short-circuit (no execute)", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Bash", { command: "rm -rf /" })] },
      { text: "moved on" },
    ]);

    let executed = false;
    const guard: Interceptor = {
      toolCall: async (ctx, next) => {
        if (ctx.name === "Bash" && /rm\s+-rf/.test(ctx.args.command ?? "")) {
          return { success: false, output: "policy: dangerous command blocked" };
        }
        return next(ctx);
      },
    };

    const agent = new AgentLoop({
      provider,
      model: "m",
      tools: [
        {
          name: "Bash",
          description: "shell",
          arguments: [{ name: "command", description: "cmd" }],
          execute: async () => {
            executed = true;
            return "ran";
          },
        },
      ],
      // Auto-approve so the legacy Bash gate doesn't intervene.
      confirm: async () => true,
      interceptors: [guard],
    });

    await agent.sendSync("delete everything");
    await agent.stop();

    expect(executed).toBe(false);
  });

  test("confirm interceptor can auto-approve without invoking the handler", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Boom", { x: "y" })] },
      { text: "ok" },
    ]);

    let confirmCalled = false;
    const auto: Interceptor = {
      confirm: async () => true,
    };

    const agent = new AgentLoop({
      provider,
      model: "m",
      tools: [
        {
          name: "Boom",
          description: "needs perm",
          arguments: [{ name: "x", description: "x" }],
          askPermission: () => "confirm boom?",
          execute: async () => "ran",
        },
      ],
      confirm: async () => {
        confirmCalled = true;
        return false;
      },
      interceptors: [auto],
    });

    await agent.sendSync("invoke boom");
    await agent.stop();

    // Interceptor short-circuited so the host's `confirm` never ran.
    expect(confirmCalled).toBe(false);
  });

  test("interceptors compose: outer redact + inner timing both observed", async () => {
    const provider = new MockProvider([{ text: "result" }]);
    const order: string[] = [];

    const outer: Interceptor = {
      llmCall: async (ctx, next) => {
        order.push("outer:before");
        const r = await next({ ...ctx, input: `[redacted] ${ctx.input}` });
        order.push("outer:after");
        return r;
      },
    };
    const inner: Interceptor = {
      llmCall: async (ctx, next) => {
        order.push(`inner:input=${ctx.input}`);
        const r = await next(ctx);
        order.push("inner:after");
        return r;
      },
    };

    const agent = new AgentLoop({
      provider,
      model: "m",
      tools: [],
      interceptors: [outer, inner],
    });

    await agent.sendSync("hello");
    await agent.stop();

    expect(order).toEqual([
      "outer:before",
      "inner:input=[redacted] hello",
      "inner:after",
      "outer:after",
    ]);
  });
});
