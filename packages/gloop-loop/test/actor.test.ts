/**
 * Actor-style AgentLoop tests — exercises the public DX surface:
 * start / send / sendSync / on / onEvent / offEvent / off / nextEvent /
 * awaitIdle / interrupt / stop, confirm_request / ask_request round-trips,
 * stable tool ids, and the chainable builder pattern.
 */

import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  JsonToolCall,
} from "../src/ai/types.js";
import {
  AgentLoop,
  type StreamChunkEvent,
  type ToolDoneEvent,
} from "../src/agent.js";

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

interface MockResponse {
  text?: string;
  toolCalls?: JsonToolCall[];
  delayMs?: number;
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
    const delayMs = resp.delayMs ?? 0;
    const textStream: AsyncIterableIterator<string> = (async function* () {
      for (let i = 0; i < text.length; i += 10) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
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

function tc(id: string, name: string, args: Record<string, string>): JsonToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ===========================================================================

describe("AgentLoop — event bus & turn lifecycle", () => {
  test("a full turn emits busy → turn_start → stream → turn_end → idle", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "hello" }]),
      model: "m",
      tools: [],
    });
    const types: string[] = [];
    agent.onEvent((e) => types.push(e.type));

    await agent.sendSync("hi");

    expect(types).toContain("busy");
    expect(types).toContain("turn_start");
    expect(types).toContain("stream_done");
    expect(types).toContain("turn_end");
    expect(types.filter((t) => t === "idle").length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  });

  test("queue_changed reflects inbox size as messages enqueue and drain", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        { text: "one", delayMs: 5 },
        { text: "two", delayMs: 5 },
        { text: "three", delayMs: 5 },
      ]),
      model: "m",
      tools: [],
    });

    const sizes: number[] = [];
    agent.on("queue_changed", (e) => sizes.push(e.pending));

    agent.send("a").send("b").send("c").start();
    await agent.awaitIdle();

    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(1);
    expect(sizes[sizes.length - 1]).toBe(0);

    await agent.stop();
  });

  test("tool_start and tool_done events are matched by stable id", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        { toolCalls: [tc("c1", "Echo", { text: "x" })] },
        { text: "done" },
      ]),
      model: "m",
      tools: [
        {
          name: "Echo",
          description: "e",
          arguments: [{ name: "text", description: "t" }],
          execute: async (a) => a.text ?? "",
        },
        {
          name: "CompleteTask",
          description: "d",
          arguments: [{ name: "summary", description: "s" }],
          execute: async (a) => a.summary ?? "",
        },
      ],
    });

    const starts: Array<{ id: string; name: string }> = [];
    const dones: Array<{ id: string; name: string; ok: boolean }> = [];
    agent
      .on("tool_start", (e) => starts.push({ id: e.id, name: e.name }))
      .on("tool_done", (e) => dones.push({ id: e.id, name: e.name, ok: e.ok }));

    await agent.sendSync("go");

    expect(starts).toHaveLength(1);
    expect(dones).toHaveLength(1);
    expect(starts[0]!.id).toBe(dones[0]!.id);
    expect(starts[0]!.name).toBe("Echo");
    expect(dones[0]!.ok).toBe(true);

    await agent.stop();
  });
});

// ===========================================================================

describe("AgentLoop — request / response dialogs", () => {
  test("confirm_request / respondToConfirm round-trip", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        { toolCalls: [tc("c1", "Bash", { command: "rm -rf /" })] },
        { text: "aborted" },
      ]),
      model: "m",
      tools: [
        {
          name: "Bash",
          description: "b",
          arguments: [{ name: "command", description: "c" }],
          execute: async (a) => a.command ?? "",
          askPermission: () => "Run a dangerous shell command?",
        },
        {
          name: "CompleteTask",
          description: "d",
          arguments: [{ name: "summary", description: "s" }],
          execute: async (a) => a.summary ?? "",
        },
      ],
    });

    let sawConfirm = false;
    agent.on("confirm_request", (e) => {
      sawConfirm = true;
      agent.respondToConfirm(e.id, false);
    });

    await agent.sendSync("please run rm -rf");
    expect(sawConfirm).toBe(true);

    await agent.stop();
  });

  test("ask_request / respondToAsk round-trip", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        { toolCalls: [tc("c1", "AskUser", { question: "favourite color?" })] },
        { text: "ok" },
      ]),
      model: "m",
      tools: [
        {
          name: "AskUser",
          description: "a",
          arguments: [{ name: "question", description: "q" }],
          execute: async () => "",
        },
        {
          name: "CompleteTask",
          description: "d",
          arguments: [{ name: "summary", description: "s" }],
          execute: async () => "",
        },
      ],
    });

    const seen: { question?: string } = {};
    agent.on("ask_request", (e) => {
      seen.question = e.question;
      agent.respondToAsk(e.id, "blue");
    });

    await agent.sendSync("ask me");
    expect(seen.question).toBe("favourite color?");

    await agent.stop();
  });
});

// ===========================================================================

describe("AgentLoop — interrupt / stop", () => {
  test("interrupt() cancels the current turn but the loop keeps running", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        { text: "a slow first response", delayMs: 50 },
        { text: "second response" },
      ]),
      model: "m",
      tools: [],
    });

    const first = agent.sendSync("first").catch((err: Error) => err);
    await agent.nextEvent("stream_chunk");
    agent.interrupt();
    const err = await first;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Interrupted/);

    expect(agent.isRunning()).toBe(true);
    await agent.sendSync("second");

    await agent.stop();
    expect(agent.isRunning()).toBe(false);
  });

  test("stop() tears the loop down even while a turn is in flight", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "slow response", delayMs: 200 }]),
      model: "m",
      tools: [],
    });

    agent.send("hi").start();
    await flush();

    await agent.stop();
    expect(agent.isRunning()).toBe(false);
  });
});

// ===========================================================================

describe("AgentLoop — send / sendSync semantics", () => {
  test("send accepts string or AgentMessage", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "1" }, { text: "2" }]),
      model: "m",
      tools: [],
    });
    const turnContents: string[] = [];
    agent.on("turn_start", (e) => turnContents.push(e.message.content));

    await agent.sendSync("plain string");
    await agent.sendSync({ role: "user", content: "typed object" });

    expect(turnContents).toEqual(["plain string", "typed object"]);
    await agent.stop();
  });

  test("send DOES NOT auto-start the actor — you must start() or sendSync", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "hi" }]),
      model: "m",
      tools: [],
    });

    agent.send("hello");
    expect(agent.isRunning()).toBe(false);
    expect(agent.pending()).toBe(1);

    agent.start();
    await agent.awaitIdle();
    expect(agent.pending()).toBe(0);

    await agent.stop();
  });

  test("sendSync auto-starts the actor", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "hi" }]),
      model: "m",
      tools: [],
    });

    expect(agent.isRunning()).toBe(false);
    await agent.sendSync("hello");
    expect(agent.isRunning()).toBe(true);

    await agent.stop();
  });

  test("send + start let you prepare messages before processing", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        { text: "1" },
        { text: "2" },
        { text: "3" },
      ]),
      model: "m",
      tools: [],
    });

    agent.send("a").send("b").send("c");
    expect(agent.isRunning()).toBe(false);
    expect(agent.pending()).toBe(3);

    agent.start();
    await agent.awaitIdle();

    expect(
      agent.convo.getHistory().filter((m) => m.role === "assistant").length,
    ).toBe(3);

    await agent.stop();
  });

  test("sendSync resolves on the matching turn_end", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "hello" }]),
      model: "m",
      tools: [],
    });

    await agent.sendSync("hi");
    expect(agent.convo.getHistory().some((m) => m.role === "assistant")).toBe(true);

    await agent.stop();
  });

  test("sendSync waits for THIS message when others are queued ahead", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        { text: "one", delayMs: 10 },
        { text: "two", delayMs: 10 },
        { text: "three", delayMs: 10 },
      ]),
      model: "m",
      tools: [],
    });

    agent.send("first").send("second");
    await agent.sendSync("third");

    expect(
      agent.convo.getHistory().filter((m) => m.role === "assistant").length,
    ).toBe(3);

    await agent.stop();
  });

  test("sendSync rejects with the turn's Error when it fails", async () => {
    class ExplodingProvider implements AIProvider {
      readonly name = "boom";
      async complete(): Promise<AIResponse> { throw new Error("provider blew up"); }
      stream(): StreamResult { throw new Error("provider blew up"); }
    }
    const agent = new AgentLoop({
      provider: new ExplodingProvider(),
      model: "m",
      tools: [],
    });

    await expect(agent.sendSync("hi")).rejects.toThrow("provider blew up");
    await agent.stop();
  });

  test("sendSync rejects with AbortError when interrupted mid-turn", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "a slow reply", delayMs: 100 }]),
      model: "m",
      tools: [],
    });

    const pending = agent.sendSync("slow");
    await agent.nextEvent("stream_chunk");
    agent.interrupt();
    await expect(pending).rejects.toThrow(/Interrupted/);

    await agent.stop();
  });
});

// ===========================================================================

describe("AgentLoop — awaitIdle", () => {
  test("resolves immediately when the actor has no work", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([]),
      model: "m",
      tools: [],
    });

    await agent.awaitIdle();
    agent.start();
    await agent.awaitIdle();

    await agent.stop();
  });

  test("resolves after all queued work drains", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        { text: "1", delayMs: 5 },
        { text: "2", delayMs: 5 },
        { text: "3", delayMs: 5 },
      ]),
      model: "m",
      tools: [],
    });

    agent.send("a").send("b").send("c").start();
    await agent.awaitIdle();

    expect(agent.pending()).toBe(0);
    expect(
      agent.convo.getHistory().filter((m) => m.role === "assistant").length,
    ).toBe(3);

    await agent.stop();
  });
});

// ===========================================================================

describe("AgentLoop — nextEvent", () => {
  test("nextEvent(type) returns a narrowed event", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        {
          toolCalls: [{
            id: "c1",
            type: "function",
            function: { name: "CompleteTask", arguments: '{"summary":"all done"}' },
          }],
        },
      ]),
      model: "m",
      tools: [
        {
          name: "CompleteTask",
          description: "done",
          arguments: [{ name: "summary", description: "s" }],
          execute: async (a) => a.summary ?? "",
        },
      ],
    });

    const donePromise = agent.nextEvent("task_complete");
    agent.send("finish").start();
    const done = await donePromise;
    expect(done.summary).toBe("all done");

    await agent.stop();
  });

  test("nextEvent(filter) matches on a predicate", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        {
          toolCalls: [
            { id: "c1", type: "function", function: { name: "Echo", arguments: '{"text":"a"}' } },
            { id: "c2", type: "function", function: { name: "Echo", arguments: '{"text":"b"}' } },
          ],
        },
        { text: "done" },
      ]),
      model: "m",
      tools: [
        {
          name: "Echo",
          description: "echo",
          arguments: [{ name: "text", description: "t" }],
          execute: async (a) => a.text ?? "",
        },
        {
          name: "CompleteTask",
          description: "done",
          arguments: [{ name: "summary", description: "s" }],
          execute: async (a) => a.summary ?? "",
        },
      ],
    });

    const firstEcho = agent.nextEvent(
      (e) => e.type === "tool_start" && e.name === "Echo",
    );
    agent.send("echo twice").start();
    const evt = await firstEcho;
    expect(evt.type).toBe("tool_start");

    await agent.awaitIdle();
    await agent.stop();
  });
});

// ===========================================================================

describe("AgentLoop — error typing", () => {
  test("error events carry an Error instance (non-Error throws are coerced)", async () => {
    class StringThrowProvider implements AIProvider {
      readonly name = "str";
      async complete(): Promise<AIResponse> { throw "plain string error"; }
      stream(): StreamResult { throw "plain string error"; }
    }
    const agent = new AgentLoop({
      provider: new StringThrowProvider(),
      model: "m",
      tools: [],
    });

    const errPromise = agent.nextEvent("error");
    agent.send("hi").start();
    const err = await errPromise;

    expect(err.error).toBeInstanceOf(Error);
    expect(err.error.message).toBe("plain string error");

    await agent.stop();
  });
});

// ===========================================================================

describe("AgentLoop — typed on(type, handler) subscription", () => {
  test("handlers are narrowed to the matching variant", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "hello" }]),
      model: "m",
      tools: [],
    });

    // Standalone handler type annotations — compile-time assertion that the
    // named event aliases are importable and match the `on` overload.
    const chunks: string[] = [];
    const onChunk = (e: StreamChunkEvent) => chunks.push(e.text);
    const onToolDone = (_e: ToolDoneEvent) => {};

    agent.on("stream_chunk", onChunk).on("tool_done", onToolDone);

    await agent.sendSync("hi");
    expect(chunks.join("")).toBe("hello");

    await agent.stop();
  });

  test("off(type, handler) removes a typed subscription by reference", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "one" }, { text: "two" }]),
      model: "m",
      tools: [],
    });

    let count = 0;
    const handler = () => {
      count++;
    };
    agent.on("turn_end", handler);

    await agent.sendSync("first");
    expect(count).toBe(1);

    agent.off("turn_end", handler);

    await agent.sendSync("second");
    expect(count).toBe(1);

    await agent.stop();
  });

  test("typed on coexists with firehose onEvent", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "x" }]),
      model: "m",
      tools: [],
    });

    let firehoseCount = 0;
    let typedCount = 0;
    agent.onEvent(() => firehoseCount++);
    agent.on("stream_done", () => typedCount++);

    await agent.sendSync("go");

    expect(firehoseCount).toBeGreaterThan(1);
    expect(typedCount).toBe(1);

    await agent.stop();
  });

  test("offEvent(listener) removes a firehose subscription", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "one" }, { text: "two" }]),
      model: "m",
      tools: [],
    });

    let count = 0;
    const listener = () => {
      count++;
    };
    agent.onEvent(listener);

    await agent.sendSync("first");
    const after1 = count;

    agent.offEvent(listener);
    await agent.sendSync("second");
    expect(count).toBe(after1);

    await agent.stop();
  });
});

// ===========================================================================

describe("AgentLoop — builder-pattern chaining", () => {
  test("every mutator returns this for fluent composition", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "ready" }]),
      model: "m",
      tools: [],
    });

    const chained = agent
      .addTool({
        name: "Hello",
        description: "h",
        arguments: [],
        execute: async () => "hi",
      })
      .setSystem("be nice")
      .on("stream_chunk", () => {})
      .on("tool_done", () => {})
      .onEvent(() => {})
      .send("go")
      .start()
      .interrupt();

    expect(chained).toBe(agent);

    await agent.stop();
  });
});

// ===========================================================================

describe("AgentLoop — role: \"system\" inbox messages", () => {
  /** Provider that records the system prompt it sees on every call. */
  class RecordingProvider implements AIProvider {
    readonly name = "rec";
    readonly seenSystems: string[] = [];
    readonly replies: string[];
    private idx = 0;

    constructor(replies: string[]) {
      this.replies = replies;
    }

    async complete(config: AIRequestConfig): Promise<AIResponse> {
      this.seenSystems.push(
        config.messages.find((m) => m.role === "system")?.content ?? "",
      );
      return {
        id: "x",
        model: "m",
        content: this.replies[this.idx++] ?? null,
        finishReason: "stop",
      };
    }

    stream(config: AIRequestConfig): StreamResult {
      this.seenSystems.push(
        config.messages.find((m) => m.role === "system")?.content ?? "",
      );
      const text = this.replies[this.idx++] ?? "";
      const textStream: AsyncIterableIterator<string> = (async function* () {
        yield text;
      })();
      return {
        textStream,
        toolCalls: Promise.resolve([]),
      finishReason: Promise.resolve(null),
        cancel: async () => {},
      };
    }
  }

  test("system message updates the prompt between user turns (inbox-ordered)", async () => {
    const provider = new RecordingProvider(["a-reply", "b-reply"]);
    const agent = new AgentLoop({
      provider,
      model: "m",
      system: "be concise",
      tools: [],
    });

    agent
      .send("A")
      .send({ role: "system", content: "be harsh" })
      .send("B")
      .start();

    await agent.awaitIdle();

    // The provider saw two LLM calls (not three — the system message
    // doesn't hit the LLM) and the system prompt swapped between them.
    expect(provider.seenSystems).toEqual(["be concise", "be harsh"]);

    await agent.stop();
  });

  test("system message emits turn_start, system_refreshed, turn_end — and NO stream events", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([]),
      model: "m",
      tools: [],
    });

    const types: string[] = [];
    agent.onEvent((e) => types.push(e.type));

    await agent.sendSync({ role: "system", content: "new prompt" });

    expect(types).toContain("turn_start");
    expect(types).toContain("system_refreshed");
    expect(types).toContain("turn_end");
    expect(types).not.toContain("stream_chunk");
    expect(types).not.toContain("stream_done");

    await agent.stop();
  });

  test("sendSync for a system message resolves after the prompt is installed", async () => {
    const provider = new RecordingProvider(["hello"]);
    const agent = new AgentLoop({
      provider,
      model: "m",
      system: "original",
      tools: [],
    });

    await agent.sendSync({ role: "system", content: "replaced" });
    await agent.sendSync("say hi");

    // The second sendSync's LLM call must have seen the replaced prompt.
    expect(provider.seenSystems).toEqual(["replaced"]);

    await agent.stop();
  });

  test("turn_start.message.role is visible to subscribers", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "ok" }]),
      model: "m",
      tools: [],
    });

    const roles: string[] = [];
    agent.on("turn_start", (e) => roles.push(e.message.role));

    agent
      .send("first")
      .send({ role: "system", content: "shhh" })
      .send("second")
      .start();

    await agent.awaitIdle();

    expect(roles).toEqual(["user", "system", "user"]);

    await agent.stop();
  });
});

describe("AgentLoop — isFatal / fatal event", () => {
  class BoomError extends Error {
    constructor() {
      super("kaboom");
      this.name = "BoomError";
    }
  }

  test("fatal errors stop the loop and emit `fatal` instead of `error`", async () => {
    class FatalProvider implements AIProvider {
      readonly name = "fatal-mock";
      async complete(): Promise<AIResponse> { throw new BoomError(); }
      stream(): StreamResult { throw new BoomError(); }
    }

    const agent = new AgentLoop({
      provider: new FatalProvider(),
      model: "m",
      tools: [],
      isFatal: (err) => err instanceof BoomError,
    });

    const fatals: Error[] = [];
    const errors: Error[] = [];
    agent.on("fatal", (e) => fatals.push(e.error));
    agent.on("error", (e) => errors.push(e.error));

    await expect(agent.sendSync("go")).rejects.toThrow("kaboom");

    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toBeInstanceOf(BoomError);
    expect(errors).toHaveLength(0); // fatal REPLACED error, not in addition
    expect(agent.isRunning()).toBe(false); // loop stopped itself

    await agent.stop();
  });

  test("non-fatal errors keep the loop running", async () => {
    let attempts = 0;
    class FlakyProvider implements AIProvider {
      readonly name = "flaky-mock";
      async complete(): Promise<AIResponse> {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        return { id: "x", model: "m", content: "ok", finishReason: "stop" };
      }
      stream(): StreamResult {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        const textStream: AsyncIterableIterator<string> = (async function* () {
          yield "ok";
        })();
        return { textStream, toolCalls: Promise.resolve([]),
      finishReason: Promise.resolve(null), cancel: async () => {} };
      }
    }

    const agent = new AgentLoop({
      provider: new FlakyProvider(),
      model: "m",
      tools: [],
      isFatal: () => false, // explicitly never fatal
    });

    await expect(agent.sendSync("first")).rejects.toThrow("transient");
    expect(agent.isRunning()).toBe(true); // still alive

    // Second turn succeeds — prove the loop kept running.
    await agent.sendSync("second");

    await agent.stop();
  });

  test("isFatal default (undefined) treats everything as regular error", async () => {
    class BoomProvider implements AIProvider {
      readonly name = "boom";
      async complete(): Promise<AIResponse> { throw new BoomError(); }
      stream(): StreamResult { throw new BoomError(); }
    }

    const agent = new AgentLoop({
      provider: new BoomProvider(),
      model: "m",
      tools: [],
      // No isFatal — everything is a regular error.
    });

    const fatals: Error[] = [];
    const errors: Error[] = [];
    agent.on("fatal", (e) => fatals.push(e.error));
    agent.on("error", (e) => errors.push(e.error));

    await expect(agent.sendSync("go")).rejects.toThrow("kaboom");

    expect(errors).toHaveLength(1);
    expect(fatals).toHaveLength(0);
    expect(agent.isRunning()).toBe(true); // default behaviour: keep going

    await agent.stop();
  });
});

describe("AgentLoop — memory defaults", () => {
  test("default remember/forget are no-ops — nothing touches disk", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([
        {
          toolCalls: [{
            id: "c1",
            type: "function",
            function: { name: "Remember", arguments: '{"content":"should not hit disk"}' },
          }],
        },
        { text: "ok" },
      ]),
      model: "m",
      tools: [
        {
          name: "Remember",
          description: "r",
          arguments: [{ name: "content", description: "c" }],
          execute: async () => "",
        },
        {
          name: "CompleteTask",
          description: "d",
          arguments: [{ name: "summary", description: "s" }],
          execute: async () => "",
        },
      ],
      // No `remember` / `forget` callbacks — defaults to no-op.
    });

    let sawMemory = false;
    agent.on("memory", (e) => {
      sawMemory = true;
      expect(e.op).toBe("remember");
      expect(e.content).toBe("should not hit disk");
    });

    await agent.sendSync("go");

    // The memory event still fires (subscribers know the agent called
    // Remember) but the default remember callback is a no-op — nothing
    // was written anywhere.
    expect(sawMemory).toBe(true);

    await agent.stop();
  });

  test("user-provided remember/forget are invoked as expected", async () => {
    const writes: string[] = [];
    const deletes: string[] = [];

    const agent = new AgentLoop({
      provider: new MockProvider([
        {
          toolCalls: [{
            id: "c1",
            type: "function",
            function: { name: "Remember", arguments: '{"content":"remember me"}' },
          }],
        },
        { text: "ok" },
      ]),
      model: "m",
      tools: [
        {
          name: "Remember",
          description: "r",
          arguments: [{ name: "content", description: "c" }],
          execute: async () => "",
        },
        {
          name: "CompleteTask",
          description: "d",
          arguments: [{ name: "summary", description: "s" }],
          execute: async () => "",
        },
      ],
      remember: async (content) => { writes.push(content); },
      forget: async (content) => { deletes.push(content); },
    });

    await agent.sendSync("go");
    expect(writes).toEqual(["remember me"]);
    expect(deletes).toEqual([]);

    await agent.stop();
  });
});

describe("AgentLoop — mutating the tool set between turns", () => {
  test("addTool / removeTool / setTools manipulate the registry", () => {
    const agent = new AgentLoop({
      provider: new MockProvider([]),
      model: "m",
      tools: [
        {
          name: "One",
          description: "1",
          arguments: [],
          execute: async () => "",
        },
      ],
    });

    expect(agent.registry.names()).toEqual(["One"]);

    agent.addTool({
      name: "Two",
      description: "2",
      arguments: [],
      execute: async () => "",
    });
    expect(agent.registry.names()).toEqual(["One", "Two"]);

    agent.removeTool("One");
    expect(agent.registry.names()).toEqual(["Two"]);

    agent.setTools([
      { name: "A", description: "a", arguments: [], execute: async () => "" },
      { name: "B", description: "b", arguments: [], execute: async () => "" },
    ]);
    expect(agent.registry.names()).toEqual(["A", "B"]);
  });

  test("tool set changes between messages are picked up on the next turn", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "first" }, { text: "second" }]),
      model: "m",
      tools: [],
    });

    await agent.sendSync("message 1");

    agent.addTool({
      name: "NewTool",
      description: "added mid-flight",
      arguments: [],
      execute: async () => "",
    });

    await agent.sendSync("message 2");
    expect(agent.registry.has("NewTool")).toBe(true);

    await agent.stop();
  });
});

// ===========================================================================
// Review regressions — fatal errors, awaitIdle, interrupting tools
// ===========================================================================

describe("AgentLoop — fatal / stop settle everything", () => {
  class RebootError extends Error {}

  test("a fatal error thrown by a TOOL emits `fatal` and stops the loop", async () => {
    const reboot = {
      name: "Reboot", description: "r", arguments: [],
      execute: async () => { throw new RebootError("new code"); },
    };
    const provider = new MockProvider([{ toolCalls: [tc("c1", "Reboot", {})] }, { text: "never" }]);
    const agent = new AgentLoop({ provider, model: "m", tools: [reboot], isFatal: (e) => e instanceof RebootError });
    const types: string[] = [];
    agent.onEvent((e) => types.push(e.type));
    await expect(agent.sendSync("go")).rejects.toBeInstanceOf(RebootError);
    expect(types).toContain("fatal");
    expect(types).not.toContain("error");
    expect(agent.isRunning()).toBe(false);
    await agent.stop();
  });

  test("queued sendSync calls reject when a fatal error stops the loop; awaitIdle resolves", async () => {
    class Boom extends Error {}
    const provider: AIProvider = {
      name: "x",
      complete: async () => { throw new Boom("b"); },
      stream: () => { throw new Boom("b"); },
    };
    const agent = new AgentLoop({ provider, model: "m", tools: [], isFatal: (e) => e instanceof Boom });
    const first = agent.sendSync("one").catch((e) => e);
    const second = agent.sendSync("two").catch((e) => e);
    const idle = agent.awaitIdle();
    expect(await first).toBeInstanceOf(Boom);
    expect(await second).toBeInstanceOf(Boom); // hung forever before
    await idle; // would hang forever before
    await agent.stop();
  });

  test("awaitIdle resolves when the actor is stopped mid-turn", async () => {
    const agent = new AgentLoop({
      provider: new MockProvider([{ text: "x".repeat(200), delayMs: 20 }]),
      model: "m", tools: [],
    });
    agent.send("go").start();
    await flush();
    const idle = agent.awaitIdle();
    await agent.stop();
    await idle;
  });
});

describe("AgentLoop — interrupt reaches running tools", () => {
  test("interrupt aborts the tool's signal, settles promptly, and records what ran", async () => {
    let signal: AbortSignal | undefined;
    const slow = {
      name: "Slow", description: "s", arguments: [],
      execute: async (_a: Record<string, string>, ctx?: { signal?: AbortSignal }) => {
        signal = ctx?.signal;
        await new Promise((r) => setTimeout(r, 1500));
        return "done";
      },
    };
    const agent = new AgentLoop({
      provider: new MockProvider([{ toolCalls: [tc("c1", "Slow", {})] }, { text: "x" }]),
      model: "m", tools: [slow],
    });
    const t0 = Date.now();
    const p = agent.sendSync("go").catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    agent.interrupt();
    expect((await p).name).toBe("AbortError");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(signal?.aborted).toBe(true);
    const h = agent.convo.getHistory();
    expect(h[1]!.toolCalls?.[0]!.id).toBe("c1");
    expect(h[2]).toEqual({ role: "tool", toolCallId: "c1", content: "Interrupted by the user before this tool call completed." });
    // …and the log agrees.
    expect(agent.snapshot().history).toEqual(h);
    await agent.stop();
  });
});

describe("AgentLoop — compaction range with foldTurns", () => {
  test("fires at the trigger and settles the context between target and trigger", async () => {
    const { ScriptedProvider, tc } = await import("./mock-provider.js");
    const { foldTurns } = await import("../src/defaults/fold-turns.js");
    const big = {
      name: "Big",
      description: "big output",
      arguments: [],
      execute: async () => Array.from({ length: 200 }, (_, i) => `filler line ${i} with some words in it`).join("\n"),
    };
    const responses = [];
    for (let n = 1; n <= 6; n++) {
      responses.push({ toolCalls: [tc(`c${n}`, "Big", {})] }, { text: `done ${n}` });
    }
    const sizes: Array<{ before: number; target?: number }> = [];
    const fold = foldTurns({ evidenceChars: 200 });
    const agent = new AgentLoop({
      provider: new ScriptedProvider(responses),
      model: "m",
      tools: [big],
      context: {
        strategy: (g, ctx) => { sizes.push({ before: ctx.tokens!, target: ctx.targetTokens }); return fold(g, ctx); },
        compactAtTokens: { trigger: 5000, target: 2500 },
      },
    });
    const est = () => agent.convo.getHistory().reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
    const after: number[] = [];
    agent.on("tool_done", (e) => { if (e.name === "ManageContext") after.push(est()); });
    for (let n = 1; n <= 6; n++) await agent.sendSync(`task ${n}`);
    await agent.stop();

    expect(sizes.length).toBe(2);
    for (const s of sizes) {
      expect(s.before).toBeGreaterThanOrEqual(5000);
      expect(s.target).toBe(2500);
    }
    for (const a of after) expect(a).toBeLessThanOrEqual(2500);
    // The last turn is whole.
    const history = agent.convo.getHistory();
    expect(history.at(-1)).toEqual({ role: "assistant", content: "done 6" });
    expect(history.some((m) => m.role === "tool")).toBe(true);
  });
});
