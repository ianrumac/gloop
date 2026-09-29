import { test, expect, describe } from "bun:test";
import { EventLog, projectGraph, type AgentEvent, type LogEvent } from "@hypen-space/gloop-loop";
import {
  clip, esc, layout, mergeEvents, parseJsonl, splitKey, summarize, turnEvents,
  NODE_W, NODE_H, GAP_X, GAP_Y, PAD,
} from "./model.ts";

function build(entries: Array<[string, string | null, AgentEvent]>, run = "t"): LogEvent[] {
  const log = new EventLog({ run });
  for (const [agent, turn, payload] of entries) log.append(payload, { agent, turn });
  return log.events();
}
const msg = (id: string, content = id, cause?: { agent: string; eventId: string }) =>
  ({ id, role: "user" as const, content, ...(cause && { cause }) });

describe("viewer model", () => {
  test("parseJsonl keeps valid events, drops blank / corrupt / non-event lines", () => {
    const text = [
      JSON.stringify({ type: "idle", eventId: "a-1", seq: 1, ts: 1, run: "a", agent: "x", turn: null }),
      "",
      "{not json",
      JSON.stringify({ foo: "bar" }),
      JSON.stringify({ type: "busy", eventId: "a-2", seq: 2, ts: 2, run: "a", agent: "x", turn: null }),
    ].join("\n");
    expect(parseJsonl(text).map((e) => e.type)).toEqual(["idle", "busy"]);
  });

  test("mergeEvents dedupes by eventId and orders by ts then seq", () => {
    const a = build([["x", null, { type: "idle" }], ["x", null, { type: "busy" }]], "a");
    const b = build([["y", null, { type: "idle" }]], "b");
    b[0]!.ts = a[0]!.ts - 10;
    const merged = mergeEvents(a, [a[1]!], b);
    expect(merged.map((e) => e.eventId)).toEqual(["b-1", "a-1", "a-2"]);
  });

  test("layout puts caused turns one column right of their cause and stacks siblings", () => {
    const events = build([
      ["p", null, { type: "message_queued", message: msg("m1") }],
      ["p", "m1", { type: "turn_start", message: msg("m1") }],
      ["p", "m1", { type: "task_complete", summary: "done" }],
    ]);
    const done = events[2]!;
    const more = build([
      ["c", null, { type: "message_queued", message: msg("m1", "c", { agent: "p", eventId: done.eventId }) }],
      ["w", null, { type: "message_queued", message: msg("m1", "w", { agent: "p", eventId: done.eventId }) }],
      ["g", null, { type: "message_queued", message: msg("m1", "g", { agent: "c", eventId: "missing" }) }],
    ], "u");
    const g = projectGraph([...events, ...more]);
    const pos = layout(g);
    expect(pos.get("p:m1")).toMatchObject({ x: PAD, y: PAD });
    expect(pos.get("c:m1")!.x).toBe(PAD + NODE_W + GAP_X);
    expect(pos.get("w:m1")!.x).toBe(PAD + NODE_W + GAP_X);
    expect(pos.get("w:m1")!.y).toBe(pos.get("c:m1")!.y + NODE_H + GAP_Y);
    // A dangling cause (not in the log) leaves the node at the root column.
    expect(pos.get("g:m1")!.x).toBe(PAD);
  });

  test("layout terminates on a cycle", () => {
    const events = build([
      ["a", null, { type: "message_queued", message: msg("m1", "a", { agent: "b", eventId: "t-2" }) }],
      ["b", null, { type: "message_queued", message: msg("m1", "b", { agent: "a", eventId: "t-1" }) }],
      ["a", "m1", { type: "turn_start", message: msg("m1") }],
      ["b", "m1", { type: "turn_start", message: msg("m1") }],
    ]);
    const pos = layout(projectGraph(events));
    expect(pos.size).toBe(2);
  });

  test("splitKey handles agent ids that contain ':'", () => {
    expect(splitKey("coder:msg_1")).toEqual(["coder", "msg_1"]);
    expect(splitKey("team:coder/task-1:msg_2")).toEqual(["team:coder/task-1", "msg_2"]);
  });

  test("turnEvents includes the message_queued that created the turn", () => {
    const events = build([
      ["a", null, { type: "message_queued", message: msg("m1") }],
      ["a", null, { type: "message_queued", message: msg("m2") }],
      ["a", "m1", { type: "turn_start", message: msg("m1") }],
      ["a", "m1", { type: "turn_end", status: "ok" }],
      ["b", "m1", { type: "turn_start", message: msg("m1") }],
    ]);
    expect(turnEvents(events, "a:m1").map((e) => `${e.agent}/${e.type}`)).toEqual([
      "a/message_queued", "a/turn_start", "a/turn_end",
    ]);
  });

  test("summarize covers every event type with a non-throwing string", () => {
    const err = { name: "E", message: "boom" };
    const samples: AgentEvent[] = [
      { type: "message_queued", message: msg("m") }, { type: "turn_start", message: msg("m") }, { type: "turn_end", status: "ok" },
      { type: "busy" }, { type: "idle" }, { type: "queue_changed", pending: 1 },
      { type: "user_message", content: "u" }, { type: "assistant_message", content: "", toolCalls: [{ id: "c", type: "function", function: { name: "T", arguments: "{}" } }] },
      { type: "tool_message", toolCallId: "c", content: "o" }, { type: "history_replaced", history: [], reason: "r" }, { type: "history_cleared" },
      { type: "system_set", system: "s" }, { type: "system_refreshed" }, { type: "tools_changed", names: ["A"] },
      { type: "llm_request", model: "m", input: null, historyLength: 0, toolCount: 0 }, { type: "stream_chunk", text: "t" }, { type: "stream_done" },
      { type: "llm_response", text: "", toolCalls: [], finishReason: null }, { type: "llm_error", error: err, attempt: 1 },
      { type: "tool_start", id: "t", name: "T", preview: "p" }, { type: "tool_done", id: "t", name: "T", ok: false, output: "x" },
      { type: "retry", boundary: "llm", attempt: 1, maxAttempts: 3, delayMs: 5, error: err }, { type: "memory", op: "remember", content: "c" },
      { type: "confirm_request", id: "c", command: "rm" }, { type: "confirm_response", id: "c", ok: false }, { type: "ask_request", id: "a", question: "?" }, { type: "ask_response", id: "a", answer: "!" },
      { type: "spawn_start", task: "t" }, { type: "spawn_done", ok: true, exitCode: 0, summary: "s", child: { agent: "k" } }, { type: "task_complete", summary: "s" },
      { type: "interrupted" }, { type: "error", error: err }, { type: "fatal", error: err }, { type: "hook_error", hook: "h", eventType: "x", error: err },
      { type: "restored", fromSeq: 1, turns: 0, requeued: 0, history: [] },
    ];
    const log = new EventLog();
    for (const s of samples) log.append(s, { agent: "a", turn: null });
    const all = log.events();
    for (const e of all) expect(typeof summarize(e)).toBe("string");
    const by = (type: string) => all.find((e) => e.type === type)!;
    expect(summarize(by("assistant_message"))).toBe("1 tool call(s)");
    expect(summarize(by("spawn_done"))).toBe("ok (0) s → k");
    expect(summarize(by("confirm_response"))).toBe("denied");
    expect(summarize(by("retry"))).toBe("llm attempt 1/3 in 5ms — boom");
  });

  test("clip and esc", () => {
    expect(clip("  a   b\n c ", 100)).toBe("a b c");
    expect(clip("abcdefgh", 5)).toBe("abcd…");
    expect(esc('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});
