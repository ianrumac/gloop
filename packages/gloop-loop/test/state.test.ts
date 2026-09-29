/**
 * Reducer / projection — pure unit tests over hand-built logs.
 */

import { test, expect, describe } from "bun:test";
import { EventLog } from "../src/log.js";
import { initialState, projectState, reduce, messagesToRequeue } from "../src/state.js";
import type { AgentEvent } from "../src/events.js";

/** Build a log from (agent, turn, payload) triples. */
function build(entries: Array<[string, string | null, AgentEvent]>): EventLog {
  const log = new EventLog({ run: "t" });
  for (const [agent, turn, payload] of entries) log.append(payload, { agent, turn });
  return log;
}

const user = (content: string): AgentEvent => ({ type: "user_message", content });
const assistant = (content: string, toolCalls?: AgentEvent extends infer _ ? any : never): AgentEvent =>
  ({ type: "assistant_message", content, ...(toolCalls && { toolCalls }) });
const tool = (toolCallId: string, content: string): AgentEvent => ({ type: "tool_message", toolCallId, content });
const call = (id: string) => ({ id, type: "function" as const, function: { name: "Echo", arguments: "{}" } });

describe("reducer — history", () => {
  test("user / assistant / tool messages append in order", () => {
    const log = build([
      ["a", "m1", user("hi")],
      ["a", "m1", assistant("hello")],
      ["a", "m1", tool("c1", "out")],
    ]);
    expect(projectState(log.events()).history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "tool", toolCallId: "c1", content: "out" },
    ]);
  });

  test("assistant_tool_calls attaches calls to the last assistant message", () => {
    const calls = [call("c1")];
    const log = build([
      ["a", "m1", assistant("thinking")],
      ["a", "m1", { type: "assistant_tool_calls", toolCalls: calls }],
      ["a", "m1", tool("c1", "ok")],
    ]);
    expect(projectState(log.events()).history).toEqual([
      { role: "assistant", content: "thinking", toolCalls: calls },
      { role: "tool", toolCallId: "c1", content: "ok" },
    ]);
  });

  test("assistant_tool_calls is ignored when the last message is not an assistant's; identical assistant texts never merge", () => {
    const calls = [call("c1")];
    const log = build([
      ["a", "m1", user("u")],
      ["a", "m1", { type: "assistant_tool_calls", toolCalls: calls }],
      ["a", "m1", assistant("same")],
      ["a", "m1", assistant("same", calls)],
    ]);
    const h = projectState(log.events()).history;
    expect(h).toHaveLength(3);
    expect(h[0]).toEqual({ role: "user", content: "u" });
    expect(h[2]).toEqual({ role: "assistant", content: "same", toolCalls: calls });
  });

  test("history_replaced / history_cleared", () => {
    const log = build([
      ["a", "m1", user("a")],
      ["a", null, { type: "history_replaced", history: [{ role: "user", content: "z" }], reason: "prune" }],
    ]);
    expect(projectState(log.events()).history).toEqual([{ role: "user", content: "z" }]);
    log.append({ type: "history_cleared" }, { agent: "a", turn: null });
    expect(projectState(log.events()).history).toEqual([]);
  });

  test("system_set and tools_changed", () => {
    const log = build([
      ["a", null, { type: "system_set", system: "be nice" }],
      ["a", null, { type: "tools_changed", names: ["A", "B"] }],
    ]);
    const s = projectState(log.events());
    expect(s.system).toBe("be nice");
    expect(s.tools).toEqual(["A", "B"]);
  });
});

describe("reducer — turns and commit points", () => {
  const msg = (id: string) => ({ id, role: "user" as const, content: id });

  test("inbox → turn_start → turn_end lifecycle and status", () => {
    const log = build([
      ["a", null, { type: "message_queued", message: msg("m1") }],
      ["a", null, { type: "message_queued", message: msg("m2") }],
      ["a", "m1", { type: "turn_start", message: msg("m1") }],
      ["a", "m1", { type: "llm_request", model: "m", input: "m1", historyLength: 0, toolCount: 0 }],
      ["a", "m1", { type: "tool_start", id: "t1", name: "Echo", preview: "" }],
      ["a", "m1", { type: "task_complete", summary: "did it" }],
      ["a", "m1", { type: "turn_end", status: "ok" }],
    ]);
    const s = projectState(log.events());
    expect(s.inbox.map((m) => m.id)).toEqual(["m2"]);
    expect(s.currentTurn).toBeNull();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toEqual(expect.objectContaining({
      id: "m1", status: "ok", llmCalls: 1, toolCalls: 1, summary: "did it", startSeq: 3, endSeq: 7,
    }));
    expect(s.completions).toEqual(["did it"]);
  });

  test("error / interrupted / fatal mark the running turn", () => {
    for (const [ev, status] of [["error", "error"], ["interrupted", "interrupted"], ["fatal", "fatal"]] as const) {
      const payload: AgentEvent = ev === "interrupted"
        ? { type: "interrupted" }
        : { type: ev, error: new Error("x") };
      const log = build([
        ["a", "m1", { type: "turn_start", message: msg("m1") }],
        ["a", "m1", payload],
      ]);
      expect(projectState(log.events()).currentTurn?.status).toBe(status);
    }
  });

  test("committedHistory lags live history until turn_end", () => {
    const log = build([
      ["a", "m1", { type: "turn_start", message: msg("m1") }],
      ["a", "m1", user("m1")],
      ["a", "m1", assistant("partial")],
    ]);
    let s = projectState(log.events());
    expect(s.history).toHaveLength(2);
    expect(s.committedHistory).toHaveLength(0);
    expect(s.currentTurn?.id).toBe("m1");

    log.append({ type: "turn_end", status: "ok" }, { agent: "a", turn: "m1" });
    s = projectState(log.events());
    expect(s.committedHistory).toHaveLength(2);
    expect(s.currentTurn).toBeNull();
  });

  test("out-of-turn changes are committed immediately", () => {
    const log = build([
      ["a", null, { type: "system_set", system: "v1" }],
      ["a", null, { type: "history_replaced", history: [{ role: "user", content: "restored" }], reason: "host" }],
    ]);
    const s = projectState(log.events());
    expect(s.committedHistory).toEqual([{ role: "user", content: "restored" }]);
    expect(s.committedSystem).toBe("v1");
  });

  test("messagesToRequeue = in-flight turn first, then inbox", () => {
    const log = build([
      ["a", null, { type: "message_queued", message: msg("m1") }],
      ["a", null, { type: "message_queued", message: msg("m2") }],
      ["a", "m1", { type: "turn_start", message: msg("m1") }],
    ]);
    expect(messagesToRequeue(projectState(log.events())).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("pending confirms / asks are tracked and cleared at turn_end", () => {
    const log = build([
      ["a", "m1", { type: "turn_start", message: msg("m1") }],
      ["a", "m1", { type: "confirm_request", id: "c1", command: "rm" }],
      ["a", "m1", { type: "ask_request", id: "q1", question: "?" }],
      ["a", "m1", { type: "confirm_response", id: "c1", ok: true }],
    ]);
    let s = projectState(log.events());
    expect(s.pendingConfirms).toEqual([]);
    expect(s.pendingAsks).toEqual([{ id: "q1", question: "?" }]);
    log.append({ type: "turn_end", status: "ok" }, { agent: "a", turn: "m1" });
    s = projectState(log.events());
    expect(s.pendingAsks).toEqual([]);
  });
});

describe("reducer — memory and agent filtering", () => {
  test("remember adds (deduped), forget removes matching entries", () => {
    const log = build([
      ["a", null, { type: "memory", op: "remember", content: "likes tea" }],
      ["a", null, { type: "memory", op: "remember", content: "likes tea" }],
      ["a", null, { type: "memory", op: "remember", content: "Uses bun" }],
      ["a", null, { type: "memory", op: "forget", content: "tea" }],
    ]);
    expect(projectState(log.events()).memory).toEqual(["Uses bun"]);
  });

  test("projectState(events, agent) ignores other agents in a shared log", () => {
    const log = build([
      ["a", "m1", user("from a")],
      ["b", "x1", user("from b")],
    ]);
    expect(projectState(log.events(), "a").history).toEqual([{ role: "user", content: "from a" }]);
    expect(projectState(log.events()).history).toHaveLength(2);
    expect(projectState(log.events(), "a").eventCount).toBe(1);
  });

  test("reduce is pure — the input state is not mutated", () => {
    const log = build([["a", null, user("x")]]);
    const before = initialState("a");
    const after = reduce(before, log.events()[0]!);
    expect(before.history).toEqual([]);
    expect(after.history).toHaveLength(1);
    expect(after.lastSeq).toBe(1);
  });
});
