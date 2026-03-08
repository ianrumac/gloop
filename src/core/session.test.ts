import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { saveRebootSession, loadRebootSession } from "./session.ts";
import { AIConversation } from "../ai/builder.ts";
import type { AIProvider, AIRequestConfig, AIResponse, StreamResult } from "../ai/types.ts";

// Minimal mock provider — session tests only use getHistory()
const mockProvider: AIProvider = {
  name: "mock",
  async complete(): Promise<AIResponse> {
    return { id: "x", model: "m", content: null, finishReason: "stop" };
  },
  stream(): StreamResult {
    const textStream: AsyncIterableIterator<string> = (async function* () {})();
    return { textStream, toolCalls: Promise.resolve([]), cancel: async () => {} };
  },
};

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

  test("loadRebootSession returns null when no file exists", async () => {
    expect(await loadRebootSession()).toBeNull();
  });

  test("saveRebootSession + loadRebootSession round-trip", async () => {
    const convo = new AIConversation(mockProvider, "m");
    convo.setHistory([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    await saveRebootSession(convo, "code updated");
    const session = await loadRebootSession();

    expect(session).not.toBeNull();
    expect(session!.history).toHaveLength(2);
    expect(session!.history[0].content).toBe("hello");
    expect(session!.reason).toBe("code updated");
  });

  test("loadRebootSession deletes file after loading", async () => {
    const convo = new AIConversation(mockProvider, "m");
    convo.setHistory([{ role: "user", content: "msg" }]);

    await saveRebootSession(convo, "test");
    const first = await loadRebootSession();
    expect(first).not.toBeNull();

    const second = await loadRebootSession();
    expect(second).toBeNull();
  });

  test("loadRebootSession returns null for corrupt file", async () => {
    const path = join(TEST_DIR, ".gloop", "reboot_session.json");
    await Bun.write(path, "not valid json{{{");

    const session = await loadRebootSession();
    expect(session).toBeNull();
  });
});
