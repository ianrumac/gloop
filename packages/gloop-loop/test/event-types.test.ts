/**
 * Type-level smoke test: verify AgentEvent discriminated union narrows
 * correctly for consumer-side subscribers.
 *
 * This file intentionally contains no `expect()` calls — its purpose is to
 * assert that the TYPES work.  If any access below becomes a TS error, the
 * public event surface has regressed.
 */

import { test, describe } from "bun:test";
import {
  AgentLoop,
  type AgentEvent,
  type AgentMessage,
} from "../src/agent.js";
import type { AIProvider, AIRequestConfig, AIResponse, StreamResult } from "../src/ai/types.js";

class NoopProvider implements AIProvider {
  readonly name = "noop";
  async complete(_c: AIRequestConfig): Promise<AIResponse> {
    return { id: "x", model: "m", content: null, finishReason: "stop" };
  }
  stream(_c: AIRequestConfig): StreamResult {
    return {
      textStream: (async function* () {})(),
      toolCalls: Promise.resolve([]),
      cancel: async () => {},
    };
  }
}

describe("event type safety (compile-time)", () => {
  test("discriminated union narrows inside a switch", () => {
    const agent = new AgentLoop({
      provider: new NoopProvider(),
      model: "m",
      tools: [],
    });

    agent.onEvent((event: AgentEvent) => {
      switch (event.type) {
        case "turn_start": {
          // event is narrowed to { type: "turn_start"; message: AgentMessage }
          const msg: AgentMessage = event.message;
          const content: string = msg.content;
          const role: "user" | "system" = msg.role;
          void content; void role;
          break;
        }
        case "stream_chunk": {
          // event is narrowed — .text exists, .summary does NOT
          const text: string = event.text;
          // @ts-expect-error — stream_chunk has no `.summary`
          const _bogus: string = event.summary;
          void text; void _bogus;
          break;
        }
        case "tool_start": {
          const id: string = event.id;
          const name: string = event.name;
          const preview: string = event.preview;
          void id; void name; void preview;
          break;
        }
        case "tool_done": {
          // Narrowed to tool_done variant — .ok is boolean, not optional
          const ok: boolean = event.ok;
          const output: string = event.output;
          void ok; void output;
          break;
        }
        case "memory": {
          // Narrowed op to literal union
          const op: "remember" | "forget" = event.op;
          void op;
          break;
        }
        case "task_complete": {
          const summary: string = event.summary;
          void summary;
          break;
        }
        case "error": {
          // event.error is Error, not unknown
          const msg: string = event.error.message;
          const stack: string | undefined = event.error.stack;
          void msg; void stack;
          break;
        }
        case "confirm_request": {
          const cmd: string = event.command;
          const id: string = event.id;
          void cmd; void id;
          break;
        }
        case "ask_request": {
          const q: string = event.question;
          void q;
          break;
        }
        case "queue_changed": {
          const pending: number = event.pending;
          void pending;
          break;
        }
        // Payloadless events still narrow to their bare variant.
        case "turn_end":
        case "busy":
        case "idle":
        case "stream_done":
        case "system_refreshed":
        case "interrupted":
          break;
      }
    });
  });

  test("nextEvent(type) returns a narrowed promise", async () => {
    const agent = new AgentLoop({
      provider: new NoopProvider(),
      model: "m",
      tools: [],
    });

    // We don't actually await these — just verify the type returned.
    const p1 = agent.nextEvent("task_complete");
    // p1 is Promise<{ type: "task_complete"; summary: string }>
    const narrowAccess: Promise<string> = p1.then((e) => e.summary);
    void narrowAccess;

    const p2 = agent.nextEvent("tool_done");
    const narrowAccess2: Promise<boolean> = p2.then((e) => e.ok);
    void narrowAccess2;

    const p3 = agent.nextEvent("error");
    const narrowAccess3: Promise<string> = p3.then((e) => e.error.message);
    void narrowAccess3;

    // nextEvent(filter) falls back to the union
    const p4 = agent.nextEvent((e) => e.type === "idle");
    const unionAccess: Promise<AgentEvent> = p4;
    void unionAccess;

    await agent.stop();
  });
});
