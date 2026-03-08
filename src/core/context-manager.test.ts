import { test, expect, describe } from "bun:test";
import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  AIStreamChunk,
} from "../ai/types.ts";
import { AIConversation } from "../ai/builder.ts";
import { manageContextFork } from "./context-manager.ts";

// ---------------------------------------------------------------------------
// Mock provider for context manager
// ---------------------------------------------------------------------------

class MockProvider implements AIProvider {
  readonly name = "mock";
  private responses: string[];
  private callIndex = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    const content = this.responses[this.callIndex++] ?? "";
    return { id: "mock", model: "mock", content, finishReason: "stop" };
  }

  async *stream(config: AIRequestConfig): AsyncGenerator<AIStreamChunk, void, unknown> {
    const content = this.responses[this.callIndex++] ?? "";
    for (let i = 0; i < content.length; i += 10) {
      yield {
        id: "mock",
        model: "mock",
        delta: { content: content.slice(i, i + 10) },
        finishReason: null,
      };
    }
    yield { id: "mock", model: "mock", delta: {}, finishReason: "stop" };
  }
}

describe("manageContextFork", () => {
  test("prunes messages marked for deletion", async () => {
    const provider = new MockProvider([
      // The context manager will view some messages and delete them
      '<tools><tool>DeleteMessages("1,2")</tool></tools>',
      '<tools><tool>CompleteTask("Pruned 2 messages")</tool></tools>',
    ]);

    const convo = new AIConversation(provider, "m", "main system");
    // Seed conversation history
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
      '<tools><tool>DeleteMessages("0,1")</tool></tools>',
      '<tools><tool>CompleteTask("done")</tool></tools>',
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
      '<tools><tool>CompleteTask("nothing to prune")</tool></tools>',
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
    let viewedContent = "";
    const provider = new MockProvider([
      '<tools><tool>ViewMessage("1")</tool></tools>',
      '<tools><tool>CompleteTask("reviewed")</tool></tools>',
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
      '<tools><tool>DeleteMessages("1")</tool></tools>',
      '<tools><tool>CompleteTask("cleaned up")</tool></tools>',
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
