import { test, expect, describe } from "bun:test";
import {
  splitShellCommand,
  parseGloopTaskBashCommand,
  appendTaskPromptSuffix,
  parseTaskCliArgs,
  TASK_PROMPT_SUFFIX,
} from "./task-mode.ts";

// ---------------------------------------------------------------------------
// splitShellCommand
// ---------------------------------------------------------------------------

describe("splitShellCommand", () => {
  test("simple tokens", () => {
    expect(splitShellCommand("echo hello world")).toEqual(["echo", "hello", "world"]);
  });

  test("double-quoted string", () => {
    expect(splitShellCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  test("single-quoted string", () => {
    expect(splitShellCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  test("backtick-quoted string", () => {
    expect(splitShellCommand("echo `hello world`")).toEqual(["echo", "hello world"]);
  });

  test("escaped spaces", () => {
    expect(splitShellCommand("echo hello\\ world")).toEqual(["echo", "hello world"]);
  });

  test("escape inside double quotes", () => {
    expect(splitShellCommand('echo "hello\\"world"')).toEqual(["echo", 'hello"world']);
  });

  test("returns null for unclosed quote", () => {
    expect(splitShellCommand('echo "unclosed')).toBeNull();
  });

  test("returns null for trailing escape", () => {
    expect(splitShellCommand("echo \\")).toBeNull();
  });

  test("empty string returns empty array", () => {
    expect(splitShellCommand("")).toEqual([]);
  });

  test("multiple spaces between tokens", () => {
    expect(splitShellCommand("a   b   c")).toEqual(["a", "b", "c"]);
  });

  test("escape in single quotes is literal", () => {
    // In single quotes, backslash is NOT an escape character
    expect(splitShellCommand("echo 'hello\\nworld'")).toEqual(["echo", "hello\\nworld"]);
  });
});

// ---------------------------------------------------------------------------
// parseGloopTaskBashCommand
// ---------------------------------------------------------------------------

describe("parseGloopTaskBashCommand", () => {
  test("parses gloop --task command", () => {
    const result = parseGloopTaskBashCommand('gloop --task "fix the bug"');
    expect(result).not.toBeNull();
    expect(result!.task).toBe("fix the bug");
  });

  test("parses with model flag", () => {
    const result = parseGloopTaskBashCommand('gloop --task "test" --model gpt-4');
    expect(result).not.toBeNull();
    expect(result!.task).toBe("test");
    expect(result!.model).toBe("gpt-4");
  });

  test("parses with equals syntax", () => {
    const result = parseGloopTaskBashCommand('gloop --task="do stuff" --model=claude');
    expect(result).not.toBeNull();
    expect(result!.task).toBe("do stuff");
    expect(result!.model).toBe("claude");
  });

  test("parses full path to gloop", () => {
    const result = parseGloopTaskBashCommand('/usr/local/bin/gloop --task "work"');
    expect(result).not.toBeNull();
    expect(result!.task).toBe("work");
  });

  test("returns null for non-gloop command", () => {
    expect(parseGloopTaskBashCommand("ls -la")).toBeNull();
  });

  test("returns null for gloop without --task", () => {
    expect(parseGloopTaskBashCommand("gloop --model foo")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseGloopTaskBashCommand("")).toBeNull();
  });

  test("returns null for malformed quotes", () => {
    expect(parseGloopTaskBashCommand('gloop --task "unclosed')).toBeNull();
  });

  test("parses --debug flag", () => {
    const result = parseGloopTaskBashCommand('gloop --task "test" --debug');
    expect(result).not.toBeNull();
    expect(result!.debug).toBe(true);
  });

  test("parses --provider flag", () => {
    const result = parseGloopTaskBashCommand('gloop --task "test" --provider openai');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// appendTaskPromptSuffix
// ---------------------------------------------------------------------------

describe("appendTaskPromptSuffix", () => {
  test("appends suffix to task", () => {
    const result = appendTaskPromptSuffix("fix the bug");
    expect(result).toContain("fix the bug");
    expect(result).toContain(TASK_PROMPT_SUFFIX);
  });

  test("does not duplicate suffix", () => {
    const withSuffix = `my task\n\n${TASK_PROMPT_SUFFIX}`;
    expect(appendTaskPromptSuffix(withSuffix)).toBe(withSuffix);
  });

  test("empty task returns just suffix", () => {
    expect(appendTaskPromptSuffix("")).toBe(TASK_PROMPT_SUFFIX);
    expect(appendTaskPromptSuffix("  ")).toBe(TASK_PROMPT_SUFFIX);
  });
});

// ---------------------------------------------------------------------------
// parseTaskCliArgs
// ---------------------------------------------------------------------------

describe("parseTaskCliArgs", () => {
  test("parses --task flag", () => {
    const result = parseTaskCliArgs(["--task", "do work"]);
    expect(result).not.toBeNull();
    expect(result!.task).toBe("do work");
  });

  test("parses all flags", () => {
    const result = parseTaskCliArgs(["--task", "work", "--model", "gpt-4", "--provider", "openai", "--debug"]);
    expect(result).not.toBeNull();
    expect(result!.task).toBe("work");
    expect(result!.model).toBe("gpt-4");
    expect(result!.provider).toBe("openai");
    expect(result!.debug).toBe(true);
  });

  test("returns null without --task", () => {
    expect(parseTaskCliArgs(["--model", "gpt-4"])).toBeNull();
  });

  test("positional arg used as model fallback", () => {
    const result = parseTaskCliArgs(["--task", "work", "gpt-4"]);
    expect(result).not.toBeNull();
    expect(result!.model).toBe("gpt-4");
  });

  test("explicit --model takes precedence over positional", () => {
    const result = parseTaskCliArgs(["--task", "work", "--model", "claude", "gpt-4"]);
    expect(result).not.toBeNull();
    expect(result!.model).toBe("claude");
  });
});
