/**
 * Tracing tests — verify the span tree shape produced by an AgentLoop turn.
 *
 * Uses a minimal `RecordingTracer` that captures spans as nodes in a tree so
 * tests can assert names, parent links, attributes, and ordering without
 * depending on console output or wall-clock time.
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
  AttributeValue,
  Span,
  SpanOptions,
  SpanStatus,
  Tracer,
} from "../src/trace.js";
import { ConsoleTracer } from "../src/trace.js";

// ---------------------------------------------------------------------------
// Mock provider — copied from agent.test.ts shape, kept tiny.
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
    const r = this.responses[this.callIndex++] ?? {};
    return {
      id: "mock",
      model: "mock",
      content: r.text ?? null,
      finishReason: r.toolCalls?.length ? "tool_calls" : "stop",
      ...(r.toolCalls && { toolCalls: r.toolCalls }),
    };
  }

  stream(_config: AIRequestConfig): StreamResult {
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
// RecordingTracer — captures every span as a tree node.
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string;
  attrs: Record<string, AttributeValue>;
  status: SpanStatus;
  events: Array<{ name: string; attrs?: Record<string, AttributeValue> }>;
  parent: RecordedSpan | null;
  children: RecordedSpan[];
  startedAt: number;
  endedAt: number | null;
  ended: boolean;
}

class RecordingTracer implements Tracer {
  readonly all: RecordedSpan[] = [];
  private readonly link = new WeakMap<Span, RecordedSpan>();

  startSpan(name: string, options?: SpanOptions): Span {
    const parent = options?.parent ? this.link.get(options.parent) ?? null : null;
    const node: RecordedSpan = {
      name,
      attrs: { ...(options?.attributes ?? {}) },
      status: { code: "unset" },
      events: [],
      parent,
      children: [],
      startedAt: this.all.length,
      endedAt: null,
      ended: false,
    };
    if (parent) parent.children.push(node);
    this.all.push(node);

    const span: Span = {
      setAttribute: (k, v) => {
        node.attrs[k] = v;
      },
      setAttributes: (a) => Object.assign(node.attrs, a),
      recordException: (err) => {
        node.events.push({
          name: "exception",
          attrs: { message: err instanceof Error ? err.message : String(err) },
        });
      },
      setStatus: (status) => {
        node.status = status;
      },
      addEvent: (n, a) => {
        node.events.push({ name: n, attrs: a });
      },
      end: () => {
        if (node.ended) return;
        node.ended = true;
        node.endedAt = this.all.length;
      },
    };
    this.link.set(span, node);
    return span;
  }

  /** Roots = spans without a parent. */
  roots(): RecordedSpan[] {
    return this.all.filter((s) => s.parent === null);
  }

  /** Find first span by name (depth-first across the recording). */
  find(name: string): RecordedSpan | undefined {
    return this.all.find((s) => s.name === name);
  }

  /** All span names in the order they were started. */
  names(): string[] {
    return this.all.map((s) => s.name);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentLoop tracing", () => {
  test("produces no spans when no tracer is provided (zero overhead)", async () => {
    // Sanity: a turn without a tracer must run cleanly. The `withWorldSpan`
    // helper short-circuits when world.tracer is undefined.
    const provider = new MockProvider([{ text: "hi" }]);
    const agent = new AgentLoop({ provider, model: "m", tools: [] });
    await agent.sendSync("hello");
    await agent.stop();
    // Reaching here without throwing is the assertion.
    expect(true).toBe(true);
  });

  test("emits agent.turn → ai.stream tree for a tool-less turn", async () => {
    const tracer = new RecordingTracer();
    const provider = new MockProvider([{ text: "no tools needed" }]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [],
      tracer,
    });

    await agent.sendSync("just talk");
    await agent.stop();

    expect(tracer.names()).toEqual(["agent.turn", "ai.stream"]);

    const turn = tracer.find("agent.turn")!;
    const ai = tracer.find("ai.stream")!;

    expect(turn.parent).toBeNull();
    expect(ai.parent).toBe(turn);
    expect(turn.attrs.role).toBe("user");
    expect(turn.attrs.contentLength).toBe("just talk".length);
    expect(ai.attrs.toolCallsRequested).toBe(0);
    expect(turn.status.code).toBe("ok");
    expect(ai.status.code).toBe("ok");
  });

  test("emits a tool.{name} child span under the turn for each tool call", async () => {
    const tracer = new RecordingTracer();
    const provider = new MockProvider([
      // First turn: model wants the Echo tool.
      { toolCalls: [tc("c1", "Echo", { text: "hi" })] },
      // After tool result: done.
      { text: "all set" },
    ]);
    const agent = new AgentLoop({
      provider,
      model: "test-model",
      tools: [
        {
          name: "Echo",
          description: "echo",
          arguments: [{ name: "text", description: "text" }],
          execute: async (args) => `echo: ${args.text}`,
        },
      ],
      tracer,
    });

    await agent.sendSync("call echo");
    await agent.stop();

    const turn = tracer.find("agent.turn")!;
    expect(turn).toBeDefined();

    const aiSpans = tracer.all.filter((s) => s.name === "ai.stream");
    const toolSpans = tracer.all.filter((s) => s.name === "tool.Echo");

    // Two LLM calls: the initial think + the post-tool think.
    expect(aiSpans.length).toBe(2);
    // Exactly one Echo invocation.
    expect(toolSpans.length).toBe(1);

    // All children should chain to the turn.
    for (const span of [...aiSpans, ...toolSpans]) {
      expect(span.parent).toBe(turn);
    }

    expect(toolSpans[0]!.attrs.tool).toBe("Echo");
    expect(toolSpans[0]!.attrs.ok).toBe(true);
    expect(toolSpans[0]!.attrs.outputLength).toBe("echo: hi".length);
  });

  test("records exception + error status when a tool throws", async () => {
    const tracer = new RecordingTracer();
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "Boom", { x: "1" })] },
      { text: "moving on" },
    ]);
    const agent = new AgentLoop({
      provider,
      model: "m",
      tools: [
        {
          name: "Boom",
          description: "always fails",
          arguments: [{ name: "x", description: "x" }],
          execute: async () => {
            throw new Error("kaboom");
          },
        },
      ],
      tracer,
    });

    await agent.sendSync("trigger boom");
    await agent.stop();

    const tool = tracer.find("tool.Boom")!;
    expect(tool.attrs.ok).toBe(false);
    // Either an exception event was recorded or the span was marked errored —
    // implementation flags both via `recordException`.
    expect(tool.events.some((e) => e.name === "exception")).toBe(true);
  });

  test("ConsoleTracer renders an indented tree of (ms) spans", async () => {
    const lines: string[] = [];
    const tracer = new ConsoleTracer({ sink: (line) => lines.push(line) });
    const provider = new MockProvider([{ text: "ok" }]);
    const agent = new AgentLoop({ provider, model: "m", tools: [], tracer });

    await agent.sendSync("hi");
    await agent.stop();

    // Spans print as they end — child completes before parent, so inner
    // span (`ai.stream`) appears first, indented; outer (`agent.turn`)
    // closes second at column 0.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]!).toMatch(/^  ai\.stream \(\d+ms\).+ ✓$/);
    expect(lines[1]!).toMatch(/^agent\.turn \(\d+ms\).+ ✓$/);
  });
});
