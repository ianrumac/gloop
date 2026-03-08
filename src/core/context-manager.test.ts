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
  test("prunes messages marked for deletion", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1,2" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "Pruned 2 messages" })] },
    ]);

    const convo = new AIConversation(provider, "m", "main system");
    convo.setHistory([
      { role: "system", content: "system prompt" },       // #0 — never deleted
      { role: "user", content: "old question" },           // #1 — will be deleted
      { role: "assistant", content: "old answer" },        // #2 — will be deleted
      { role: "user", content: "current question" },       // #3 — kept
      { role: "assistant", content: "current answer" },    // #4 — kept
    ]);

    const result = await manageContextFork(convo, "remove old stuff");

    expect(result).toContain("removed 2");
    const remaining = convo.getHistory();
    expect(remaining).toHaveLength(3);
    expect(remaining[0].content).toBe("system prompt");
    expect(remaining[1].content).toBe("current question");
    expect(remaining[2].content).toBe("current answer");
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
    // Only index 1 should be deleted, not 0
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

    expect(result).toContain("removed 0");
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

    // The fork should have seen the message — we check the result is reasonable
    expect(convo.getHistory()).toHaveLength(2); // No deletions
  });

  test("returns summary string", async () => {
    const provider = new MockProvider([
      { toolCalls: [tc("c1", "DeleteMessages", { indexes: "1" })] },
      { toolCalls: [tc("c2", "CompleteTask", { summary: "cleaned up" })] },
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
});
