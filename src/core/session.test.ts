import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { AgentLoop, MemoryEventStore, type LogEvent } from "@hypen-space/gloop-loop";
import { ScriptedProvider } from "@hypen-space/gloop-loop/testing";
import {
  saveRebootSession,
  loadRebootSession,
  newSessionLogPath,
  latestSessionLogPath,
  openSessionStore,
  resolveSessionLog,
  isTaskSessionLog,
} from "./session.ts";

const provider = (replies: string[]) => new ScriptedProvider(replies.map((text) => ({ text })));

const TEST_DIR = join(import.meta.dirname, "__test_session_tmp__");
let originalCwd: string;

describe("session persistence", () => {
  beforeEach(async () => {
    originalCwd = process.cwd();
    await Bun.$`mkdir -p ${TEST_DIR}/.gloop`.quiet();
    process.chdir(TEST_DIR);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await Bun.$`rm -rf ${TEST_DIR}`.quiet();
  });

  test("newSessionLogPath lives under .gloop/sessions and sorts chronologically", () => {
    const a = newSessionLogPath(new Date("2026-01-01T00:00:00Z"));
    const b = newSessionLogPath(new Date("2026-01-02T00:00:00Z"));
    expect(a).toContain(join(".gloop", "sessions"));
    expect(a.endsWith(".jsonl")).toBe(true);
    expect(a < b).toBe(true);
  });

  test("latestSessionLogPath is null without sessions, else the newest top-level file — never a task log", async () => {
    expect(latestSessionLogPath()).toBeNull();
    const older = newSessionLogPath(new Date("2026-01-01T00:00:00Z"));
    const newer = newSessionLogPath(new Date("2026-03-01T00:00:00Z"));
    const child = newSessionLogPath(new Date("2026-03-01T00:00:05Z"), "task-e171c23e");
    await Bun.write(older, "");
    await Bun.write(newer, "");
    await Bun.write(child, "");
    expect(isTaskSessionLog(child)).toBe(true);
    expect(latestSessionLogPath()).toBe(newer);
  });

  test("resolveSessionLog: reboot > --session > --resume [path] > fresh", () => {
    const latest = () => "/s/latest.jsonl";
    const fresh = () => "/s/fresh.jsonl";
    expect(resolveSessionLog({ reboot: { log: "/s/reboot.jsonl" }, resume: { requested: true }, latest, fresh })).toBe("/s/reboot.jsonl");
    expect(resolveSessionLog({ session: "/s/child.jsonl", resume: { requested: true }, latest, fresh })).toBe("/s/child.jsonl");
    expect(resolveSessionLog({ resume: { requested: true, path: "/s/x.jsonl" }, latest, fresh })).toBe("/s/x.jsonl");
    expect(resolveSessionLog({ resume: { requested: true }, latest, fresh })).toBe("/s/latest.jsonl");
    expect(resolveSessionLog({ resume: { requested: true }, latest: () => null, fresh })).toBeNull();
    expect(resolveSessionLog({ latest, fresh })).toBe("/s/fresh.jsonl");
  });

  test("a session log round-trips through AgentLoop.resume", async () => {
    const path = newSessionLogPath();
    const first = new AgentLoop({ provider: provider(["hello back"]), model: "m", system: "sys", tools: [], store: openSessionStore(path) });
    await first.sendSync("hello");
    await first.stop();

    const second = await AgentLoop.resume({ provider: provider([]), model: "m", system: "sys", tools: [], store: openSessionStore(path) });
    expect(second.convo.getHistory()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hello back" },
    ]);
    // Ephemeral events are filtered out of the file.
    const persisted = await openSessionStore(path).load();
    expect(persisted.some((e: LogEvent) => e.type === "stream_chunk")).toBe(false);
    expect(persisted.some((e: LogEvent) => e.type === "assistant_message")).toBe(true);
    await second.stop();
  });

  test("loadRebootSession returns null when no file exists", async () => {
    expect(await loadRebootSession()).toBeNull();
  });

  test("saveRebootSession round-trips the pointer", async () => {
    await saveRebootSession("/tmp/some-log.jsonl", "code updated");
    const session = await loadRebootSession();
    expect(session).toEqual(expect.objectContaining({ reason: "code updated", log: "/tmp/some-log.jsonl" }));
  });

  test("loadRebootSession deletes file after loading", async () => {
    await saveRebootSession("/tmp/x.jsonl", "test");
    expect(await loadRebootSession()).not.toBeNull();
    expect(await loadRebootSession()).toBeNull();
  });

  test("loadRebootSession returns null for corrupt or legacy files", async () => {
    const path = join(TEST_DIR, ".gloop", "reboot_session.json");
    await Bun.write(path, "not valid json{{{");
    expect(await loadRebootSession()).toBeNull();
    // Pre-event-log format (history inline, no log path) is ignored.
    await Bun.write(path, JSON.stringify({ history: [], reason: "old" }));
    expect(await loadRebootSession()).toBeNull();
  });

  test("MemoryEventStore is a drop-in for tests", async () => {
    const store = new MemoryEventStore();
    const a = new AgentLoop({ provider: provider(["r"]), model: "m", tools: [], store });
    await a.sendSync("q");
    await a.stop();
    expect(store.load().length).toBeGreaterThan(0);
  });
});
