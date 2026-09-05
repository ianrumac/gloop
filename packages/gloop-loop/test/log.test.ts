/**
 * EventLog / stores — envelope stamping, ordering, subscriptions, persistence,
 * load-time dedupe, causal graph helpers, and JSONL round-trips.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, MemoryEventStore, parseJsonlEvents, type EventStore } from "../src/log.js";
import { createJsonlEventStore } from "../src/defaults/jsonl-store.js";
import { isEphemeralEvent, serializeEvent, toErrorInfo, type LogEvent } from "../src/events.js";

const A = { agent: "a", turn: null } as const;

describe("EventLog — envelope", () => {
  test("stamps seq, eventId, ts, run, agent, turn, parent", () => {
    const log = new EventLog({ run: "r1" });
    const e1 = log.append({ type: "idle" }, A);
    const e2 = log.append({ type: "busy" }, { agent: "a", turn: "msg_1", parent: e1.eventId });

    expect(e1.seq).toBe(1);
    expect(e1.eventId).toBe("r1-1");
    expect(e1.run).toBe("r1");
    expect(e1.agent).toBe("a");
    expect(e1.turn).toBeNull();
    expect(e1.parent).toBeUndefined();
    expect(typeof e1.ts).toBe("number");

    expect(e2.seq).toBe(2);
    expect(e2.turn).toBe("msg_1");
    expect(e2.parent).toBe("r1-1");
    expect(log.size).toBe(2);
    expect(log.lastSeq).toBe(2);
  });

  test("payload `id` fields survive the envelope (tool_start.id vs eventId)", () => {
    const log = new EventLog({ run: "r" });
    const e = log.append({ type: "tool_start", id: "tool_7", name: "Echo", preview: "" }, A);
    expect(e.id).toBe("tool_7");
    expect(e.eventId).toBe("r-1");
  });

  test("events() returns a copy; eventsFor filters by agent", () => {
    const log = new EventLog();
    log.append({ type: "idle" }, A);
    log.append({ type: "idle" }, { agent: "b", turn: null });
    const copy = log.events();
    copy.length = 0;
    expect(log.size).toBe(2);
    expect(log.eventsFor("b")).toHaveLength(1);
  });

  test("get / ancestors / children walk the causal graph", () => {
    const log = new EventLog({ run: "r" });
    const root = log.append({ type: "turn_start", message: { role: "user", content: "x" } }, A);
    const req = log.append({ type: "llm_request", model: "m", input: "x", historyLength: 0, toolCount: 0 }, { ...A, parent: root.eventId });
    const chunk = log.append({ type: "stream_chunk", text: "hi" }, { ...A, parent: req.eventId });
    const resp = log.append({ type: "llm_response", text: "hi", toolCalls: [], finishReason: "stop" }, { ...A, parent: req.eventId });

    expect(log.get(req.eventId)?.type).toBe("llm_request");
    expect(log.ancestors(resp.eventId).map((e) => e.type)).toEqual(["llm_response", "llm_request", "turn_start"]);
    expect(log.children(req.eventId).map((e) => e.eventId)).toEqual([chunk.eventId, resp.eventId]);
  });
});

describe("EventLog — subscriptions", () => {
  test("subscribers see every append; unsubscribe stops delivery", () => {
    const log = new EventLog();
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.type));
    log.append({ type: "idle" }, A);
    off();
    log.append({ type: "busy" }, A);
    expect(seen).toEqual(["idle"]);
  });

  test("a throwing subscriber does not stop others or the append", () => {
    const log = new EventLog();
    const seen: string[] = [];
    log.subscribe(() => { throw new Error("boom"); });
    log.subscribe((e) => seen.push(e.type));
    const e = log.append({ type: "idle" }, A);
    expect(e.seq).toBe(1);
    expect(seen).toEqual(["idle"]);
  });
});

describe("EventLog — persistence", () => {
  test("appends reach the store in order; flush waits for all of them", async () => {
    const written: number[] = [];
    const store: EventStore = {
      append: async (e) => {
        // Slow first write to prove ordering is enforced by the chain.
        await new Promise((r) => setTimeout(r, e.seq === 1 ? 10 : 0));
        written.push(e.seq);
      },
      load: () => [],
    };
    const log = new EventLog({ store });
    log.append({ type: "idle" }, A);
    log.append({ type: "busy" }, A);
    log.append({ type: "idle" }, A);
    expect(written).toEqual([]);
    await log.flush();
    expect(written).toEqual([1, 2, 3]);
  });

  test("store errors are reported and do not break the log", async () => {
    const errors: unknown[] = [];
    const store: EventStore = {
      append: async () => { throw new Error("disk full"); },
      load: () => [],
    };
    const log = new EventLog({ store, onStoreError: (err) => errors.push(err) });
    log.append({ type: "idle" }, A);
    log.append({ type: "busy" }, A);
    await log.flush();
    expect(errors).toHaveLength(2);
    expect(log.size).toBe(2);
  });

  test("load() seeds from the store, dedupes by eventId, continues seq", async () => {
    const seed = new EventLog({ run: "old" });
    seed.append({ type: "idle" }, A);
    seed.append({ type: "busy" }, A);
    const events = seed.events();
    // Duplicate a line, as a store that replays a partial flush might.
    const store = new MemoryEventStore([...events, events[1]!]);

    const log = new EventLog({ store, run: "new" });
    const loaded = await log.load();
    expect(loaded).toHaveLength(2);
    expect(log.lastSeq).toBe(2);
    const next = log.append({ type: "idle" }, A);
    expect(next.seq).toBe(3);
    expect(next.eventId).toBe("new-3");
    // load is idempotent
    expect(await log.load()).toHaveLength(3);
  });

  test("MemoryEventStore keeps serialisable copies (Error → ErrorInfo)", async () => {
    const store = new MemoryEventStore();
    const log = new EventLog({ store });
    log.append({ type: "error", error: new TypeError("bad") }, A);
    await log.flush();
    const stored = store.load()[0] as LogEvent<"error">;
    expect(stored.error).toEqual(expect.objectContaining({ name: "TypeError", message: "bad" }));
    expect(stored.error instanceof Error).toBe(false);
  });
});

describe("JSONL store", () => {
  async function withDir(fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "gloop-jsonl-"));
    try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }

  test("round-trips events through a file, creating parent dirs", () =>
    withDir(async (dir) => {
      const path = join(dir, "nested", "session.jsonl");
      const store = createJsonlEventStore(path);
      const log = new EventLog({ store, run: "w" });
      log.append({ type: "user_message", content: "hello" }, { agent: "a", turn: "m1" });
      log.append({ type: "error", error: new Error("x") }, { agent: "a", turn: "m1" });
      await log.flush();

      const lines = (await readFile(path, "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(2);

      const reloaded = new EventLog({ store: createJsonlEventStore(path) });
      const events = await reloaded.load();
      expect(events.map((e) => e.type)).toEqual(["user_message", "error"]);
      expect((events[1] as LogEvent<"error">).error).toEqual(expect.objectContaining({ message: "x" }));
      expect(reloaded.lastSeq).toBe(2);
    }));

  test("skips corrupt / partial lines and honours filter", () =>
    withDir(async (dir) => {
      const path = join(dir, "s.jsonl");
      const store = createJsonlEventStore(path, { filter: (e) => !isEphemeralEvent(e) });
      const log = new EventLog({ store, run: "w" });
      log.append({ type: "stream_chunk", text: "noise" }, A);   // filtered out
      log.append({ type: "user_message", content: "kept" }, A);
      await log.flush();
      await writeFile(path, (await readFile(path, "utf-8")) + '{"type":"user_message","con', "utf-8");

      const events = await createJsonlEventStore(path).load();
      expect(events.map((e) => e.type)).toEqual(["user_message"]);
    }));

  test("load on a missing file yields []; any other read error surfaces", () =>
    withDir(async (dir) => {
      expect(await createJsonlEventStore(join(dir, "nope.jsonl")).load()).toEqual([]);
      await expect(createJsonlEventStore(dir).load()).rejects.toThrow();
      // …and a failed EventLog.load() can be retried once the store works.
      let fail = true;
      const store: EventStore = { append() {}, load: () => { if (fail) throw new Error("io"); return []; } };
      const log = new EventLog({ store });
      await expect(log.load()).rejects.toThrow("io");
      fail = false;
      await expect(log.load()).resolves.toEqual([]);
    }));

  test("parseJsonlEvents is the one definition of a valid persisted line", () => {
    const good = { type: "idle", eventId: "r-1", seq: 1, ts: 1, run: "r", agent: "a", turn: null } as LogEvent;
    const text = [JSON.stringify(good), "", "{oops", JSON.stringify({ type: "idle" }), JSON.stringify({ foo: 1 })].join("\n");
    expect(parseJsonlEvents(text)).toEqual([good]);
  });
});

describe("event helpers", () => {
  test("isEphemeralEvent classifies progress-only events", () => {
    expect(isEphemeralEvent({ type: "stream_chunk" })).toBe(true);
    expect(isEphemeralEvent({ type: "idle" })).toBe(true);
    expect(isEphemeralEvent({ type: "user_message" })).toBe(false);
  });

  test("toErrorInfo handles Error, error-like, and primitives", () => {
    expect(toErrorInfo(new RangeError("r"))).toEqual(expect.objectContaining({ name: "RangeError", message: "r" }));
    expect(toErrorInfo({ message: "m" })).toEqual({ name: "Error", message: "m" });
    expect(toErrorInfo("s")).toEqual({ name: "Error", message: "s" });
  });

  test("serializeEvent leaves non-error events untouched", () => {
    const log = new EventLog();
    const e = log.append({ type: "idle" }, A);
    expect(serializeEvent(e)).toBe(e);
  });
});
