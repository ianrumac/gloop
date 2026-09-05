import { test, expect, describe } from "bun:test";
import { parseGloopArgs } from "./cli-args.ts";
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
