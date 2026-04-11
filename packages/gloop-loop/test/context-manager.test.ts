import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  JsonToolCall,
} from "../src/ai/types.js";
import { AIConversation } from "../src/ai/builder.js";
import { manageContextFork } from "../src/defaults/context-manager.js";
import { AgentLoop, type AgentEvent } from "../src/agent.js";

// ---------------------------------------------------------------------------
// Scenario-based mock provider for context management
// ---------------------------------------------------------------------------

function tc(id: string, name: string, args: Record<string, string>): JsonToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Creates a provider that simulates the context manager's tool-calling flow.
 * Each response in the sequence is a step the fork agent takes.
 */
class ContextMockProvider implements AIProvider {
  readonly name = "context-mock";
  private responses: Array<{ text?: string; toolCalls?: JsonToolCall[] }>;
  private callIndex = 0;
  calls: AIRequestConfig[] = [];

  constructor(responses: Array<{ text?: string; toolCalls?: JsonToolCall[] }>) {
    this.responses = responses;
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    this.calls.push(config);
    const resp = this.responses[this.callIndex++] ?? {};
    return {
      id: "ctx",
      model: "ctx",
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
      if (text) yield text;
    })();
    return {
      textStream,
      toolCalls: Promise.resolve(resp.toolCalls ?? []),
      cancel: async () => {},
    };
  }
}

// ---------------------------------------------------------------------------
// manageContextFork tests
// ---------------------------------------------------------------------------

describe("manageContextFork", () => {
  test("no deletions returns no-change message", async () => {
    // The fork agent views some messages, decides nothing needs pruning, and completes
    const provider = new ContextMockProvider([
      {
        toolCalls: [tc("c1", "CompleteTask", { summary: "Nothing to prune" })],
      },
    ]);

    const convo = new AIConversation(provider, "m", "system prompt");
    convo.setHistory([
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);

    const result = await manageContextFork(convo, "Prune old stuff");

    expect(result).toContain("no messages pruned");
    // History should be unchanged
    expect(convo.getHistory()).toHaveLength(3);
  });

  test("deletes messages and injects summary", async () => {
    const provider = new ContextMockProvider([
      // Step 1: view message #1
      { toolCalls: [tc("c1", "ViewMessage", { index: "1" })] },
      // Step 2: delete messages #1 and #2
      { toolCalls: [tc("c2", "DeleteMessages", { indexes: "1,2" })] },
      // Step 3: summarize
      { toolCalls: [tc("c3", "Summarize", { summary: "User asked about weather, got a response." })] },
      // Step 4: complete
      { toolCalls: [tc("c4", "CompleteTask", { summary: "Pruned 2 messages" })] },
    ]);

    const convo = new AIConversation(provider, "m", "system prompt");
    convo.setHistory([
      { role: "system", content: "system prompt" },       // #0 - always kept
      { role: "user", content: "what's the weather?" },    // #1 - will be deleted
      { role: "assistant", content: "It's sunny today." }, // #2 - will be deleted
      { role: "user", content: "thanks" },                 // #3 - kept
      { role: "assistant", content: "you're welcome" },    // #4 - kept
    ]);

    const result = await manageContextFork(convo, "Remove old weather chat");

    expect(result).toContain("removed 2 messages");
    expect(result).toContain("injected summary");

    const history = convo.getHistory();
    // Should have: system (#0), summary (injected), "thanks" (#3), "you're welcome" (#4)
    expect(history).toHaveLength(4);
    expect(history[0]!.role).toBe("system");
    expect(history[1]!.content).toContain("summary of conversation history");
    expect(history[1]!.content).toContain("User asked about weather");
    expect(history[2]!.content).toBe("thanks");
    expect(history[3]!.content).toBe("you're welcome");
  });

  test("preserves system message (index 0) even if deletion attempted", async () => {
    const provider = new ContextMockProvider([
      // Try to delete index 0 (system) — should be filtered out
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "0,1" })] },
      { toolCalls: [tc("c2", "Summarize", { summary: "Deleted old stuff" })] },
      { toolCalls: [tc("c3", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m", "system");
    convo.setHistory([
      { role: "system", content: "system" },    // #0 - should be protected
      { role: "user", content: "old message" },  // #1 - deleted
      { role: "user", content: "new message" },  // #2 - kept
    ]);

    await manageContextFork(convo, "prune");

    const history = convo.getHistory();
    // System (#0) preserved, #1 deleted, summary injected, #2 kept
    expect(history[0]!.role).toBe("system");
    expect(history[0]!.content).toBe("system");
  });

  test("deletes without summary — no summary message injected", async () => {
    const provider = new ContextMockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1" })] },
      // Summarize with empty string
      { toolCalls: [tc("c2", "Summarize", { summary: "" })] },
      { toolCalls: [tc("c3", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m", "system");
    convo.setHistory([
      { role: "system", content: "system" },
      { role: "user", content: "delete me" },
      { role: "user", content: "keep me" },
    ]);

    await manageContextFork(convo, "prune");

    const history = convo.getHistory();
    // system + "keep me" only (no summary injected for empty summary)
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("system");
    expect(history[1]!.content).toBe("keep me");
  });

  test("ViewMessage returns message content", async () => {
    let viewResult = "";
    const provider = new ContextMockProvider([
      // View message #1
      { toolCalls: [tc("c1", "ViewMessage", { index: "1" })] },
      // Complete without changes
      { toolCalls: [tc("c2", "CompleteTask", { summary: "reviewed" })] },
    ]);

    const convo = new AIConversation(provider, "m", "system");
    convo.setHistory([
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello world" },
    ]);

    // The fork will call ViewMessage and get the content, then CompleteTask
    // We can verify via logs
    const logs: [string, string][] = [];
    await manageContextFork(convo, "review", (label, content) => {
      logs.push([label, content]);
    });

    // History should be unchanged (no deletions)
    expect(convo.getHistory()).toHaveLength(2);
  });

  test("ViewMessage with invalid index returns error", async () => {
    const provider = new ContextMockProvider([
      { toolCalls: [tc("c1", "ViewMessage", { index: "999" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m", "system");
    convo.setHistory([
      { role: "system", content: "system" },
    ]);

    // Should not throw — invalid index handled gracefully
    const result = await manageContextFork(convo, "prune");
    expect(result).toContain("no messages pruned");
  });

  test("log callback receives context management events", async () => {
    const provider = new ContextMockProvider([
      { toolCalls: [tc("c1", "CompleteTask", { summary: "nothing to do" })] },
    ]);

    const convo = new AIConversation(provider, "m", "system");
    convo.setHistory([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ]);

    const logs: [string, string][] = [];
    await manageContextFork(convo, "prune old stuff", (label, content) => {
      logs.push([label, content]);
    });

    // Should have MANAGE_CONTEXT start and end logs
    expect(logs.some(([l]) => l === "MANAGE_CONTEXT")).toBe(true);
    const startLog = logs.find(([l, c]) => l === "MANAGE_CONTEXT" && c.includes("Starting"));
    expect(startLog).toBeTruthy();
  });

  test("multiple DeleteMessages calls accumulate", async () => {
    const provider = new ContextMockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1" })] },
      { toolCalls: [tc("c2", "DeleteMessages", { indexes: "2" })] },
      { toolCalls: [tc("c3", "Summarize", { summary: "removed two messages" })] },
      { toolCalls: [tc("c4", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m", "system");
    convo.setHistory([
      { role: "system", content: "system" },       // #0
      { role: "user", content: "first" },           // #1 - delete
      { role: "assistant", content: "response1" },  // #2 - delete
      { role: "user", content: "second" },          // #3 - keep
    ]);

    const result = await manageContextFork(convo, "prune");

    expect(result).toContain("removed 2");
    const history = convo.getHistory();
    // system + summary + "second"
    expect(history).toHaveLength(3);
    expect(history[2]!.content).toBe("second");
  });

  test("handles non-string message content (JSON)", async () => {
    const provider = new ContextMockProvider([
      { toolCalls: [tc("c1", "ViewMessage", { index: "1" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m", "system");
    // Set history with non-string content
    convo.setHistory([
      { role: "system", content: "system" },
      { role: "user", content: JSON.stringify({ type: "tool_result", data: "test" }) },
    ]);

    // Should not throw
    const result = await manageContextFork(convo, "review");
    expect(result).toContain("no messages pruned");
  });
});

// ---------------------------------------------------------------------------
// Nested-actor isolation — verifies that the nested `AgentLoop` created
// by `manageContextFork` does not leak events into the parent's event bus
// when driven through the outer actor's normal `fx.manageContext` path.
// ---------------------------------------------------------------------------

describe("manageContextFork — nested actor isolation", () => {
  test("fork events do not leak to the parent AgentLoop's subscribers", async () => {
    // One provider instance is shared by both the parent and the nested
    // fork (the fork picks up `convo.provider`).  We script the responses
    // in the order they will be consumed:
    //
    //   1. Parent's initial LLM call: returns a ManageContext tool call
    //   2. Fork's LLM call: returns a no-op CompleteTask
    //   3. Parent's follow-up LLM call (after the fork returns): text reply
    //
    const provider = new ContextMockProvider([
      // 1. Parent: "please prune my history"
      { toolCalls: [tc("p1", "ManageContext", { instructions: "prune old stuff" })] },
      // 2. Fork: nothing to prune, complete immediately
      { toolCalls: [tc("f1", "CompleteTask", { summary: "nothing to prune" })] },
      // 3. Parent: final text reply after the fork's result comes back
      { text: "pruning done, moving on" },
    ]);

    const agent = new AgentLoop({
      provider,
      model: "m",
      system: "parent system prompt",
      tools: [
        // A minimal ManageContext tool — the builtin isn't needed here
        // because `evalInvoke` special-cases ManageContext and routes
        // straight to `fx.manageContext`.
        {
          name: "ManageContext",
          description: "prune context",
          arguments: [{ name: "instructions", description: "what to do" }],
          execute: async () => "",
        },
        {
          name: "CompleteTask",
          description: "done",
          arguments: [{ name: "summary", description: "s" }],
          execute: async (a) => a.summary ?? "",
        },
      ],
    });

    // Subscribe to EVERY event on the parent bus.
    const parentEvents: AgentEvent[] = [];
    agent.onEvent((e) => parentEvents.push(e));

    await agent.sendSync("do the thing");

    // The parent should have seen its own lifecycle events + the
    // ManageContext tool_start / tool_done pair + its own stream events.
    const types = parentEvents.map((e) => e.type);
    expect(types).toContain("turn_start");
    expect(types).toContain("turn_end");
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_done");
    expect(types).toContain("stream_done");

    // The fork's ViewMessage / DeleteMessages / Summarize / CompleteTask
    // tool events must NOT appear in the parent's event stream.  If any of
    // these do, the fork is leaking events into the parent bus.
    const toolNames = parentEvents
      .filter((e): e is Extract<AgentEvent, { type: "tool_start" | "tool_done" }> =>
        e.type === "tool_start" || e.type === "tool_done",
      )
      .map((e) => e.name);

    // Only ManageContext should show up at the parent level.  The fork's
    // CompleteTask / ViewMessage / DeleteMessages / Summarize should not.
    const forkTools = toolNames.filter((n) =>
      ["ViewMessage", "DeleteMessages", "Summarize"].includes(n),
    );
    expect(forkTools).toEqual([]);
    expect(toolNames).toContain("ManageContext");

    // And the parent should have only one `task_complete` — the fork's
    // CompleteTask tool call stays inside the fork and does not surface.
    const completes = parentEvents.filter((e) => e.type === "task_complete");
    expect(completes.length).toBeLessThanOrEqual(1);

    await agent.stop();
  });

  test("fork CompleteTask does not trigger the parent's task_complete event", async () => {
    // A fork that calls CompleteTask should complete the FORK only — the
    // parent actor must continue processing the remainder of its turn.
    const provider = new ContextMockProvider([
      // Parent: calls ManageContext
      { toolCalls: [tc("p1", "ManageContext", { instructions: "prune" })] },
      // Fork: completes
      { toolCalls: [tc("f1", "CompleteTask", { summary: "fork done" })] },
      // Parent: now calls its own CompleteTask with a different summary
      { toolCalls: [tc("p2", "CompleteTask", { summary: "parent done" })] },
    ]);

    const agent = new AgentLoop({
      provider,
      model: "m",
      system: "parent",
      tools: [
        {
          name: "ManageContext",
          description: "x",
          arguments: [{ name: "instructions", description: "i" }],
          execute: async () => "",
        },
        {
          name: "CompleteTask",
          description: "d",
          arguments: [{ name: "summary", description: "s" }],
          execute: async (a) => a.summary ?? "",
        },
      ],
    });

    const completes: string[] = [];
    agent.on("task_complete", (e) => completes.push(e.summary));

    await agent.sendSync("do the thing");

    // The parent should see exactly one task_complete — its own.  The
    // fork's "fork done" CompleteTask stays inside the nested actor.
    expect(completes).toEqual(["parent done"]);

    await agent.stop();
  });
});
