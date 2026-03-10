import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  JsonToolCall,
  StreamResult,
} from "../ai/types.ts";
import { AIConversation } from "../ai/builder.ts";
import { manageContextFork } from "./context-manager.ts";

// ---------------------------------------------------------------------------
// Mock provider for context manager — returns JSON tool calls
// ---------------------------------------------------------------------------

interface MockResponse {
  text?: string;
  toolCalls?: JsonToolCall[];
}

/** Shorthand to create a JsonToolCall */
function tc(id: string, name: string, args: Record<string, string>): JsonToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

class MockProvider implements AIProvider {
  readonly name = "mock";
  private responses: MockResponse[];
  private callIndex = 0;

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
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

describe("manageContextFork", () => {
  test("prunes messages and injects summary", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1,2" })] },
      { toolCalls: [tc("c2", "Summarize", { summary: "User asked about dark mode. Assistant explained the toggle implementation." })] },
      { toolCalls: [tc("c3", "CompleteTask", { summary: "Pruned 2 messages" })] },
    ]);

    const convo = new AIConversation(provider, "m", "main system");
    convo.setHistory([
      { role: "system", content: "system prompt" },       // #0
      { role: "user", content: "old question" },           // #1 — deleted
      { role: "assistant", content: "old answer" },        // #2 — deleted
      { role: "user", content: "current question" },       // #3 — kept
      { role: "assistant", content: "current answer" },    // #4 — kept
    ]);

    const result = await manageContextFork(convo, "remove old stuff");

    expect(result).toContain("removed 2");
    expect(result).toContain("summary");
    const remaining = convo.getHistory();
    // system + summary + 2 kept = 4
    expect(remaining).toHaveLength(4);
    expect(remaining[0].content).toBe("system prompt");
    expect(remaining[1].content).toContain("[This is a summary of conversation history up to this point]");
    expect(remaining[1].content).toContain("dark mode");
    expect(remaining[1].role).toBe("user");
    expect(remaining[2].content).toBe("current question");
    expect(remaining[3].content).toBe("current answer");
  });

  test("prunes without summary when Summarize not called", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1,2" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "Pruned 2 messages" })] },
    ]);

    const convo = new AIConversation(provider, "m", "main system");
    convo.setHistory([
      { role: "system", content: "system prompt" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current question" },
    ]);

    await manageContextFork(convo, "remove old stuff");

    const remaining = convo.getHistory();
    // system + current = 2 (no summary injected)
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toBe("system prompt");
    expect(remaining[1].content).toBe("current question");
  });

  test("cannot delete system message (index 0)", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "0,1" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "system" },
      { role: "user", content: "msg" },
    ]);

    await manageContextFork(convo, "prune");

    const remaining = convo.getHistory();
    // Only index 1 deleted, system kept
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("system");
  });

  test("no deletions keeps all messages", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "CompleteTask", { summary: "nothing to prune" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "sys" },
      { role: "user", content: "important" },
    ]);

    const result = await manageContextFork(convo, "check history");

    expect(result).toContain("no messages pruned");
    expect(convo.getHistory()).toHaveLength(2);
  });

  test("ViewMessage returns correct message content", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "ViewMessage", { index: "1" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "reviewed" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "system" },
      { role: "user", content: "detailed user message" },
    ]);

    await manageContextFork(convo, "review");

    expect(convo.getHistory()).toHaveLength(2); // No deletions
  });

  test("returns summary string with removed count", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1" })] },
      { toolCalls: [tc("c2", "Summarize", { summary: "Old message was about setup." })] },
      { toolCalls: [tc("c3", "CompleteTask", { summary: "cleaned up" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "user", content: "current" },
    ]);

    const result = await manageContextFork(convo, "prune");

    expect(typeof result).toBe("string");
    expect(result).toContain("removed");
    expect(result).toContain("remaining");
  });

  test("out-of-bounds indexes are ignored", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "0,1,99,100" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "system" },
      { role: "user", content: "msg" },
    ]);

    await manageContextFork(convo, "prune");

    // Index 0 protected, 99/100 OOB, only 1 deleted
    expect(convo.getHistory()).toHaveLength(1);
    expect(convo.getHistory()[0].content).toBe("system");
  });

  test("duplicate indexes only delete once", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1,1,1" })] },
      { toolCalls: [tc("c2", "Summarize", { summary: "Removed a duplicate user msg." })] },
      { toolCalls: [tc("c3", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "system" },
      { role: "user", content: "to delete" },
      { role: "assistant", content: "keep" },
    ]);

    const result = await manageContextFork(convo, "prune");

    // system + summary + keep = 3
    expect(convo.getHistory()).toHaveLength(3);
    expect(result).toContain("removed 1");
  });

  test("multiple DeleteMessages calls accumulate", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1" })] },
      { toolCalls: [tc("c2", "DeleteMessages", { indexes: "2" })] },
      { toolCalls: [tc("c3", "Summarize", { summary: "Removed two old messages." })] },
      { toolCalls: [tc("c4", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "system" },
      { role: "user", content: "old 1" },
      { role: "assistant", content: "old 2" },
      { role: "user", content: "keep" },
    ]);

    await manageContextFork(convo, "prune");

    // system + summary + keep = 3
    expect(convo.getHistory()).toHaveLength(3);
    expect(convo.getHistory()[0].content).toBe("system");
    expect(convo.getHistory()[1].content).toContain("summary of conversation history");
    expect(convo.getHistory()[2].content).toBe("keep");
  });

  test("invalid index strings are filtered", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "abc,1,xyz" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "sys" },
      { role: "user", content: "delete me" },
      { role: "assistant", content: "keep" },
    ]);

    await manageContextFork(convo, "prune");

    // system + keep = 2 (no summary since Summarize wasn't called)
    expect(convo.getHistory()).toHaveLength(2);
    expect(convo.getHistory()[1].content).toBe("keep");
  });

  test("summary message has correct format", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1" })] },
      { toolCalls: [tc("c2", "Summarize", { summary: "Key facts:\n- User wants dark mode\n- API key is set up" })] },
      { toolCalls: [tc("c3", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "sys" },
      { role: "user", content: "old stuff" },
      { role: "user", content: "current" },
    ]);

    await manageContextFork(convo, "prune");

    const summaryMsg = convo.getHistory()[1];
    expect(summaryMsg.role).toBe("user");
    expect(summaryMsg.content).toMatch(/^\[This is a summary of conversation history up to this point\]/);
    expect(summaryMsg.content).toContain("dark mode");
    expect(summaryMsg.content).toContain("API key");
  });

  test("empty Summarize text does not inject message", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1" })] },
      { toolCalls: [tc("c2", "Summarize", { summary: "" })] },
      { toolCalls: [tc("c3", "CompleteTask", { summary: "done" })] },
    ]);

    const convo = new AIConversation(provider, "m");
    convo.setHistory([
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "user", content: "current" },
    ]);

    await manageContextFork(convo, "prune");

    // system + current = 2, no summary injected
    expect(convo.getHistory()).toHaveLength(2);
    expect(convo.getHistory()[0].content).toBe("sys");
    expect(convo.getHistory()[1].content).toBe("current");
  });
});
