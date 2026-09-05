import { test, expect, describe } from "bun:test";
import { parseGloopArgs, parseHeadlessArgs } from "./cli-args.ts";
import { TASK_PROMPT_SUFFIX, encodeCause } from "./task-mode.ts";
import { DEFAULT_GLOOP_MODEL } from "./default-model.ts";

describe("parseGloopArgs", () => {
  test("defaults", () => {
    expect(parseGloopArgs([])).toEqual({ clone: false, debug: false, resume: { requested: false }, model: DEFAULT_GLOOP_MODEL });
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
});


describe("parseHeadlessArgs", () => {
  test("defaults and the bare instruction", () => {
    const a = parseHeadlessArgs(["do the thing"]);
    expect(a).toEqual({ model: DEFAULT_GLOOP_MODEL, outputPath: "gloop-output.jsonl", debug: false, clone: false, instruction: "do the thing", agentId: "gloop" });
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
});
