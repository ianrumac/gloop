import { expect, test } from "bun:test";
import {
  TASK_PROMPT_SUFFIX,
  appendTaskPromptSuffix,
  parseGloopTaskBashCommand,
  parseTaskCliArgs,
  splitShellCommand,
} from "./src/core/task-mode.ts";

test("appendTaskPromptSuffix appends suffix once", () => {
  const task = "Summarize the changelog";
  const once = appendTaskPromptSuffix(task);
  const twice = appendTaskPromptSuffix(once);

  expect(once).toContain(task);
  expect(once).toContain(TASK_PROMPT_SUFFIX);
  expect(twice).toBe(once);
});

test("parseTaskCliArgs parses task + model + provider", () => {
  const parsed = parseTaskCliArgs([
    "--task",
    "Audit the API",
    "--model",
    "x-ai/grok-4.1-fast",
    "--provider",
    "openrouter",
    "--debug",
  ]);

  expect(parsed).toEqual({
    task: "Audit the API",
    model: "x-ai/grok-4.1-fast",
    provider: "openrouter",
    debug: true,
  });
});

test("parseTaskCliArgs supports positional model", () => {
  const parsed = parseTaskCliArgs(["anthropic/claude-sonnet-4", "--task", "Find flaky tests"]);
  expect(parsed?.model).toBe("anthropic/claude-sonnet-4");
  expect(parsed?.task).toBe("Find flaky tests");
});

test("splitShellCommand handles quoted args", () => {
  const tokens = splitShellCommand('gloop --task "Summarize logs for svc-a" --model x/y');
  expect(tokens).toEqual(["gloop", "--task", "Summarize logs for svc-a", "--model", "x/y"]);
});

test("parseGloopTaskBashCommand detects gloop task command", () => {
  const parsed = parseGloopTaskBashCommand(
    'gloop --task "Write release notes" --model x-ai/grok-4.1-fast --provider openrouter',
  );
  expect(parsed).toEqual({
    task: "Write release notes",
    model: "x-ai/grok-4.1-fast",
    provider: "openrouter",
    debug: false,
  });
});

test("parseGloopTaskBashCommand ignores non-gloop commands", () => {
  const parsed = parseGloopTaskBashCommand('echo "gloop --task \\"do work\\""');
  expect(parsed).toBeNull();
});
