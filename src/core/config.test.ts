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
  formatCompactAt,
  inheritedFlags,
  loadSettings,
  matchSettingFlag,
  missingApiKeyMessage,
  parseCompactAt,
  resolveCompactAt,
  resolveSettings,
  toolOutputCapNote,
} from "./config.ts";

describe("resolveSettings", () => {
  test("defaults depend on the mode", () => {
    expect(resolveSettings({ mode: "interactive" }).settings).toEqual({
      maxIterations: 200, retries: 3, maxToolOutput: 50_000, compactAt: 0.85, compaction: "fold", taskTimeoutMs: 1_800_000,
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
    expect(err({ mode: "interactive", file: { compactAt: "120000" } })).toContain('"compactAt" must be a fraction of the context window');
    expect(err({ mode: "interactive", file: [1, 2] })).toContain("expected a JSON object");
  });

  test("integer flags accept _ separators", () => {
    expect(resolveSettings({ mode: "interactive", flags: { compactAt: "80_000" } }).settings.compactAt).toBe(80_000);
    expect(resolveSettings({ mode: "interactive", flags: { contextWindow: "200_000" } }).settings.contextWindow).toBe(200_000);
  });

  test("compactAt: fraction, token count, range, 0", () => {
    const flag = (v: string) => resolveSettings({ mode: "interactive", flags: { compactAt: v } }).settings.compactAt;
    const file = (v: unknown) => resolveSettings({ mode: "interactive", file: { compactAt: v } }).settings.compactAt;
    expect(flag("0.85")).toBe(0.85);
    expect(flag("1")).toBe(1);
    expect(flag("150000")).toBe(150_000);
    expect(flag("0")).toBe(0);
    expect(flag("0.6-0.85")).toEqual([0.6, 0.85]);
    expect(flag("90000-150000")).toEqual([90_000, 150_000]);
    expect(flag("90_000..150_000")).toEqual([90_000, 150_000]);
    expect(flag(".6..0.85")).toEqual([0.6, 0.85]);
    expect(file([0.6, 0.85])).toEqual([0.6, 0.85]);
    expect(file(90_000)).toBe(90_000);

    const bad = (input: Parameters<typeof resolveSettings>[0]) => expect(() => resolveSettings(input)).toThrow(ConfigError);
    for (const v of ["1.5", "-1", "0.85-0.6", "0.6-90000", "90000-90000", "0-0.5", "1-2-3", "abc", "", "0.6-"]) {
      bad({ mode: "interactive", flags: { compactAt: v } });
    }
    for (const v of [1.5, -0.5, [0.85, 0.6], [0.5, 100_000], [1, 2, 3], [0, 0.5], "0.85"]) bad({ mode: "interactive", file: { compactAt: v } });
    expect(() => resolveSettings({ mode: "interactive", flags: { compactAt: "0.85-0.6" } }))
      .toThrow('Invalid --compact-at "0.85-0.6": expected a fraction of the context window (0 < x <= 1), a token count (> 1), or a range [target, trigger] of one kind with target < trigger (0 = never).');
    bad({ mode: "interactive", flags: { contextWindow: "0" } });
  });

  test("parseCompactAt / formatCompactAt round-trip", () => {
    expect(parseCompactAt(formatCompactAt([0.6, 0.85]))).toEqual([0.6, 0.85]);
    expect(parseCompactAt(formatCompactAt(150_000))).toBe(150_000);
    expect(parseCompactAt("x")).toBeNaN();
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
    // Default 0.85 of the window; 128k when no window is given.
    expect(o.context?.compactAtTokens).toBe(108_800);
    expect(agentOptionsFor(defaultSettings("interactive"), 200_000).context?.compactAtTokens).toBe(170_000);
    expect(agentOptionsFor({ ...defaultSettings("interactive"), compactAt: [0.6, 0.85] }, 200_000).context?.compactAtTokens)
      .toEqual({ trigger: 170_000, target: 120_000 });
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

describe("resolveCompactAt", () => {
  test("fractions are taken of the window; absolute values pass through; 0 is off", () => {
    expect(resolveCompactAt(0, 200_000)).toEqual({ tokens: 0 });
    expect(resolveCompactAt(0.85, 200_000)).toEqual({ tokens: 170_000 });
    expect(resolveCompactAt(1, 200_000)).toEqual({ tokens: 200_000 });
    expect(resolveCompactAt(150_000, 200_000)).toEqual({ tokens: 150_000 });
    expect(resolveCompactAt([0.5, 0.75], 1_000_000)).toEqual({ tokens: { trigger: 750_000, target: 500_000 } });
    expect(resolveCompactAt([90_000, 150_000], 200_000)).toEqual({ tokens: { trigger: 150_000, target: 90_000 } });
  });

  test("an absolute trigger above the window is clamped to 95% of it, with a notice", () => {
    const r = resolveCompactAt(150_000, 128_000);
    expect(r.tokens).toBe(121_600);
    expect(r.notice).toBe("compactAt 150000 is above the model's 128000-token context window; compacting at 121600 instead.");
    // The target stays when it still fits under the clamped trigger…
    expect(resolveCompactAt([90_000, 150_000], 128_000).tokens).toEqual({ trigger: 121_600, target: 90_000 });
    // …and is scaled down with it when it does not.
    const both = resolveCompactAt([140_000, 200_000], 128_000);
    expect(both.tokens).toEqual({ trigger: 121_600, target: 85_120 });
    expect(both.notice).toContain("(target 85120)");
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

  test("compactAt ranges and contextWindow are passed on as flags", () => {
    const r = resolveSettings({ mode: "interactive", file: { compactAt: [0.6, 0.85], contextWindow: 200_000 } });
    const flags = inheritedFlags(r);
    expect(flags).toEqual({ compactAt: "0.6-0.85", contextWindow: "200000" });
    expect(flagsToArgv(flags)).toEqual(["--compact-at", "0.6-0.85", "--context-window", "200000"]);
    // …and parse back to the same settings in the child.
    expect(resolveSettings({ mode: "headless", flags }).settings).toMatchObject({ compactAt: [0.6, 0.85], contextWindow: 200_000 });
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
