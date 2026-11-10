import { test, expect, describe } from "bun:test";
import { parseGloopArgs, parseHeadlessArgs } from "./cli-args.ts";
import { TASK_PROMPT_SUFFIX, encodeCause } from "./task-mode.ts";
import { DEFAULT_GLOOP_MODEL } from "./default-model.ts";

describe("parseGloopArgs", () => {
  test("defaults", () => {
    expect(parseGloopArgs([])).toEqual({ clone: false, debug: false, resume: { requested: false }, model: DEFAULT_GLOOP_MODEL, settings: {} });
  });

  test("model is the first bare positional", () => {
    expect(parseGloopArgs(["anthropic/claude-sonnet-4.5", "--debug"]).model).toBe("anthropic/claude-sonnet-4.5");
  });

  test("--provider and --resume values are not mistaken for the model", () => {
    const a = parseGloopArgs(["--provider", "anthropic", "--resume", ".gloop/sessions/x.jsonl", "some/model"]);
    expect(a.providerName).toBe("anthropic");
    expect(a.resume).toEqual({ requested: true, path: ".gloop/sessions/x.jsonl" });
    expect(a.model).toBe("some/model");
  });

  test("--resume without a path resumes the latest session", () => {
    expect(parseGloopArgs(["--resume", "--debug"]).resume).toEqual({ requested: true });
    expect(parseGloopArgs(["--resume"]).resume).toEqual({ requested: true });
    expect(parseGloopArgs(["--resume", "x-ai/grok"]).resume).toEqual({ requested: true, path: "x-ai/grok" });
  });

  test("flags", () => {
    const a = parseGloopArgs(["--clone", "--debug"]);
    expect(a.clone).toBe(true);
    expect(a.debug).toBe(true);
  });

  test("setting flags are collected raw and their values are not taken for the model", () => {
    const a = parseGloopArgs(["--max-iterations", "50", "--retries=1", "--compact-at", "0", "--compaction", "llm", "some/model"]);
    expect(a.settings).toEqual({ maxIterations: "50", retries: "1", compactAt: "0", compaction: "llm" });
    expect(a.model).toBe("some/model");
  });

  test("--compact-at ranges and --context-window", () => {
    const a = parseGloopArgs(["--compact-at", "0.6-0.85", "--context-window=200000", "some/model"]);
    expect(a.settings).toEqual({ compactAt: "0.6-0.85", contextWindow: "200000" });
    expect(a.model).toBe("some/model");
    expect(parseHeadlessArgs(["--compact-at=90000..150000", "--context-window", "64000", "go"]).settings)
      .toEqual({ compactAt: "90000..150000", contextWindow: "64000" });
  });

  test("a setting flag without a value is kept as empty so validation can reject it", () => {
    expect(parseGloopArgs(["--max-tool-output", "--debug"]).settings).toEqual({ maxToolOutput: "" });
  });
});


describe("parseHeadlessArgs", () => {
  test("defaults and the bare instruction", () => {
    const a = parseHeadlessArgs(["do the thing"]);
    expect(a).toEqual({ model: DEFAULT_GLOOP_MODEL, outputPath: "gloop-output.jsonl", debug: false, clone: false, instruction: "do the thing", agentId: "gloop", settings: {} });
  });

  test("subagent wiring: --session, --agent-id, --cause", () => {
    const cause = { agent: "gloop", eventId: "r-7", log: "/s/parent.jsonl" };
    const a = parseHeadlessArgs(["--session", "/s/child.jsonl", "--agent-id", "gloop/task-1", "--cause", encodeCause(cause), "--model", "m", "go"]);
    expect(a.session).toBe("/s/child.jsonl");
    expect(a.agentId).toBe("gloop/task-1");
    expect(a.cause).toEqual(cause);
    expect(a.model).toBe("m");
    expect(a.instruction).toBe("go");
  });

  test("--task and --task= append the completion suffix; flags set their fields", () => {
    expect(parseHeadlessArgs(["--task", "fix it"]).instruction).toBe(`fix it\n\n${TASK_PROMPT_SUFFIX}`);
    expect(parseHeadlessArgs(["--task=fix it"]).instruction).toContain(TASK_PROMPT_SUFFIX);
    const a = parseHeadlessArgs(["--debug", "--clone", "--provider", "anthropic", "--output", "/o.jsonl", "x"]);
    expect(a).toMatchObject({ debug: true, clone: true, providerName: "anthropic", outputPath: "/o.jsonl" });
    expect(parseHeadlessArgs(["--cause", "garbage", "x"]).cause).toBeUndefined();
  });

  test("setting flags (as passed to --task children)", () => {
    const a = parseHeadlessArgs(["--max-iterations", "7", "--task-timeout", "1000", "--max-tool-output", "0", "go"]);
    expect(a.settings).toEqual({ maxIterations: "7", taskTimeoutMs: "1000", maxToolOutput: "0" });
    expect(a.instruction).toBe("go");
  });
});
