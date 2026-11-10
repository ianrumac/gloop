import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ContextGraph, ContextStrategyContext } from "@hypen-space/gloop-loop";
import {
  ConfigError,
  agentOptionsFor,
  contextStrategyFor,
  defaultSettings,
  flagsToArgv,
  inheritedFlags,
  loadSettings,
  matchSettingFlag,
  missingApiKeyMessage,
  resolveSettings,
  toolOutputCapNote,
} from "./config.ts";

describe("resolveSettings", () => {
  test("defaults depend on the mode", () => {
    expect(resolveSettings({ mode: "interactive" }).settings).toEqual({
      maxIterations: 200, retries: 3, maxToolOutput: 50_000, compactAt: 120_000, compaction: "fold", taskTimeoutMs: 1_800_000,
    });
    expect(resolveSettings({ mode: "headless" }).settings.maxIterations).toBe(100);
  });

  test("flags override the file, the file overrides defaults", () => {
    const r = resolveSettings({
      mode: "interactive",
      file: { maxIterations: 50, retries: 1, maxTokens: 8000, keepTurns: 5 },
      flags: { maxIterations: "10", compactAt: "0" },
    });
    expect(r.settings).toMatchObject({ maxIterations: 10, retries: 1, maxTokens: 8000, keepTurns: 5, compactAt: 0 });
    expect(r.sources).toMatchObject({ maxIterations: "flag", retries: "file", compactAt: "flag", maxToolOutput: "default" });
  });

  test("unknown file keys are ignored with a note", () => {
    const r = resolveSettings({ mode: "headless", file: { $schema: "x", maxIteration: 5 } });
    expect(r.notes).toEqual(['.gloop/config.json: ignoring unknown key "maxIteration"']);
    expect(r.settings.maxIterations).toBe(100);
  });

  test("invalid values are clear errors", () => {
    const err = (input: Parameters<typeof resolveSettings>[0]) => {
      try {
        resolveSettings(input);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error("expected a ConfigError");
    };
    expect(err({ mode: "interactive", flags: { maxIterations: "lots" } }))
      .toBe('Invalid --max-iterations "lots": expected a non-negative integer (0 = unlimited).');
    expect(err({ mode: "interactive", flags: { retries: "0" } })).toContain("expected a positive integer (1 = no retry)");
    expect(err({ mode: "interactive", flags: { maxToolOutput: "" } })).toContain("--max-tool-output");
    expect(err({ mode: "interactive", file: { compaction: "summarise" } }))
      .toBe('.gloop/config.json: "compaction" must be "fold" or "llm", got "summarise".');
    expect(err({ mode: "interactive", file: { compactAt: "120000" } })).toContain('"compactAt" must be a non-negative integer');
    expect(err({ mode: "interactive", file: [1, 2] })).toContain("expected a JSON object");
  });

  test("integer flags accept _ separators", () => {
    expect(resolveSettings({ mode: "interactive", flags: { compactAt: "80_000" } }).settings.compactAt).toBe(80_000);
  });
});

describe("loadSettings", () => {
  test("reads .gloop/config.json from cwd; a missing file is fine; bad JSON is a ConfigError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gloop-config-"));
    expect((await loadSettings("interactive", {}, dir)).settings).toEqual(defaultSettings("interactive"));
    mkdirSync(join(dir, ".gloop"));
    writeFileSync(join(dir, ".gloop", "config.json"), JSON.stringify({ taskTimeoutMs: 0 }));
    expect((await loadSettings("headless", {}, dir)).settings.taskTimeoutMs).toBe(0);
    writeFileSync(join(dir, ".gloop", "config.json"), "{ nope");
    await expect(loadSettings("headless", {}, dir)).rejects.toThrow(/config\.json: not valid JSON/);
  });
});

describe("matchSettingFlag", () => {
  test("space and = forms; unknown flags", () => {
    expect(matchSettingFlag("--retries", "2")).toEqual({ key: "retries", value: "2", consumedNext: true });
    expect(matchSettingFlag("--task-timeout=5000", undefined)).toEqual({ key: "taskTimeoutMs", value: "5000", consumedNext: false });
    expect(matchSettingFlag("--compact-at", "--debug")).toEqual({ key: "compactAt", value: "", consumedNext: false });
    expect(matchSettingFlag("--model", "x")).toBeNull();
  });
});

describe("agentOptionsFor", () => {
  test("maps settings onto AgentLoop options", () => {
    const o = agentOptionsFor(defaultSettings("interactive"));
    expect(o.maxIterations).toBe(200);
    expect(o.retry).toEqual({ llm: { attempts: 3, backoffMs: 1000 } });
    expect(o.maxToolOutputChars).toBe(50_000);
    expect(o.context?.compactAtTokens).toBe(120_000);
    expect(typeof o.context?.strategy).toBe("function");
    expect("maxTokens" in o).toBe(false);
    expect("llmIdleTimeoutMs" in o).toBe(false);
  });

  test("retries: 1 disables retry; file-only keys pass through", () => {
    const o = agentOptionsFor({ ...defaultSettings("headless"), retries: 1, maxTokens: 4096, llmIdleTimeoutMs: 0 });
    expect(o.retry).toBeUndefined();
    expect(o.maxTokens).toBe(4096);
    expect(o.llmIdleTimeoutMs).toBe(0);
  });
});

describe("contextStrategyFor", () => {
  // Dispatch by trigger: the LLM fork needs ctx.provider, fold needs nothing.
  const graph: ContextGraph = { agent: "a", nodes: [], edges: [] };
  const ctx = (trigger: "tool" | "auto") => ({ trigger }) as ContextStrategyContext;

  test("fold mode: automatic compaction folds without calling a model", async () => {
    const strategy = contextStrategyFor({ compaction: "fold", keepTurns: 2 });
    // The LLM strategy would need ctx.provider; fold does not.
    expect(await strategy(graph, ctx("auto"))).toEqual(graph);
  });

  test("fold mode: the model's own ManageContext call uses the LLM fork", async () => {
    const strategy = contextStrategyFor({ compaction: "fold" });
    // No provider in ctx: the LLM path fails — proving it was chosen.
    await expect(Promise.resolve().then(() => strategy(graph, ctx("tool")))).rejects.toThrow();
  });
});

describe("subagent inheritance", () => {
  test("only explicitly set values are passed on", () => {
    const r = resolveSettings({ mode: "interactive", file: { retries: 5 }, flags: { maxIterations: "40" } });
    const flags = inheritedFlags(r);
    expect(flags).toEqual({ maxIterations: "40", retries: "5" });
    expect(flagsToArgv(flags)).toEqual(["--max-iterations", "40", "--retries", "5"]);
  });
});

describe("startup checks", () => {
  test("missing API key message unless a base URL is set", () => {
    expect(missingApiKeyMessage({})).toContain("OPENROUTER_API_KEY is not set");
    expect(missingApiKeyMessage({ OPENROUTER_API_KEY: "k" })).toBeNull();
    expect(missingApiKeyMessage({ OPENROUTER_BASE_URL: "http://localhost:1234/v1" })).toBeNull();
  });

  test("tool output cap note", () => {
    expect(toolOutputCapNote(50_000)).toContain("50,000 characters");
    expect(toolOutputCapNote(0)).toBe("");
  });
});
