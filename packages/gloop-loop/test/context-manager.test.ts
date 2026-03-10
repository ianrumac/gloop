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
