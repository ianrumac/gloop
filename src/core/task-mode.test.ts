import { test, expect, describe } from "bun:test";
import {
  buildTaskArgv,
  decodeCause,
  encodeCause,
  splitShellCommand,
  parseGloopTaskBashCommand,
  appendTaskPromptSuffix,
  parseTaskCliArgs,
  TASK_PROMPT_SUFFIX,
  hasShellSyntax,
  runTaskSubagent,
  taskSpawnOptions,
  childInheritFlags,
  formatDuration,
} from "./task-mode.ts";
import { trackedChildCount } from "./children.ts";

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

  test("parses setting flags", () => {
    const result = parseGloopTaskBashCommand('gloop --task "test" --max-iterations 20 --task-timeout=60000');
    expect(result!.settings).toEqual({ maxIterations: "20", taskTimeoutMs: "60000" });
  });

  test("is not a spawn when the command does more than run gloop", () => {
    // Treating these as spawns would silently drop everything after the task.
    for (const cmd of [
      'gloop --task "x" && echo done',
      'gloop --task "x" > out.txt',
      'gloop --task "x" | tee log',
      'gloop --task "x"; ls',
      'gloop --task "x" &',
      'gloop --task "$(cat task.txt)"',
      "gloop --task `cat task.txt`",
      'gloop --task "x" 2>&1',
      'gloop --task "x"\necho hi',
    ]) {
      expect(parseGloopTaskBashCommand(cmd)).toBeNull();
    }
  });

  test("operators inside quotes are part of the task", () => {
    expect(parseGloopTaskBashCommand('gloop --task "build && test; report > file | grep x"')!.task)
      .toBe("build && test; report > file | grep x");
    expect(parseGloopTaskBashCommand("gloop --task 'costs $5 (maybe)'")!.task).toBe("costs $5 (maybe)");
  });
});

describe("hasShellSyntax", () => {
  test("plain commands and quoted operators", () => {
    expect(hasShellSyntax("gloop --task hi")).toBe(false);
    expect(hasShellSyntax('echo "a && b"')).toBe(false);
    expect(hasShellSyntax("echo 'a | b'")).toBe(false);
    expect(hasShellSyntax("echo a\\;b")).toBe(false);
    expect(hasShellSyntax("echo $HOME")).toBe(true);
    expect(hasShellSyntax('echo "$HOME"')).toBe(true);
    expect(hasShellSyntax("a || b")).toBe(true);
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


describe("subagent log linking", () => {
  test("encodeCause / decodeCause round-trip, with and without a log locator", () => {
    const withLog = { agent: "gloop", eventId: "run1-42", log: "/x/.gloop/sessions/a@b.jsonl" };
    expect(decodeCause(encodeCause(withLog))).toEqual(withLog);
    const noLog = { agent: "gloop", eventId: "run1-42" };
    expect(decodeCause(encodeCause(noLog))).toEqual(noLog);
    expect(decodeCause("garbage")).toBeNull();
    expect(decodeCause(JSON.stringify({ agent: "a" }))).toBeNull();
    // Paths with "@" or ":" are no problem for a JSON wire format.
    const odd = { agent: "gloop", eventId: "r-1", log: "/tmp/we@ird:path.jsonl" };
    expect(decodeCause(encodeCause(odd))).toEqual(odd);
  });

  test("buildTaskArgv passes session, agent id and cause to the child", () => {
    const argv = buildTaskArgv(
      { task: "do it", model: "m" },
      "/tmp/out.jsonl",
      { sessionLog: "/s/child.jsonl", agentId: "gloop/task-abc", cause: { agent: "gloop", eventId: "r-7", log: "/s/parent.jsonl" } },
    );
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("--session")).toBe("/s/child.jsonl");
    expect(at("--agent-id")).toBe("gloop/task-abc");
    expect(decodeCause(at("--cause")!)).toEqual({ agent: "gloop", eventId: "r-7", log: "/s/parent.jsonl" });
    expect(at("--model")).toBe("m");
    expect(argv[argv.length - 1]).toContain("do it");
  });

  test("buildTaskArgv passes setting flags through", () => {
    const argv = buildTaskArgv(
      { task: "do it" },
      "/tmp/out.jsonl",
      { sessionLog: "/s/c.jsonl", agentId: "a", flags: { maxIterations: "5", compaction: "llm" } },
    );
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("--max-iterations")).toBe("5");
    expect(at("--compaction")).toBe("llm");
  });
});

// ---------------------------------------------------------------------------
// runTaskSubagent — with a fake child standing in for headless.ts
// ---------------------------------------------------------------------------

/** argv for a child that writes `lines` to the JSONL output, then runs `then` (shell). */
const fakeChild = (lines: object[], then = "") => (out: string) => [
  "sh", "-c",
  `printf '%s\\n' ${lines.map((l) => `'${JSON.stringify(l)}'`).join(" ")} > "${out}"; ${then}`,
];

describe("runTaskSubagent", () => {
  test("returns the summary and the child's token usage", async () => {
    const r = await runTaskSubagent({ task: "t" }, {
      sessionLog: "/tmp/x.jsonl",
      argv: fakeChild([
        { type: "complete", summary: "all done" },
        { type: "usage", promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      ]),
    });
    expect(r.success).toBe(true);
    expect(r.summary).toBe("all done");
    expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  });

  test("a child that runs past its time limit is killed and reported", async () => {
    const start = Date.now();
    const r = await runTaskSubagent({ task: "t" }, {
      sessionLog: "/tmp/x.jsonl",
      timeoutMs: 150,
      killGraceMs: 100,
      argv: fakeChild([], "sleep 11"),
    });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.success).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(r.summary).toContain("timed out after 0s");
    expect(trackedChildCount()).toBe(0);
  });

  test("a request's --task-timeout overrides the parent's limit", async () => {
    const r = await runTaskSubagent({ task: "t", settings: { taskTimeoutMs: "100" } }, {
      sessionLog: "/tmp/x.jsonl",
      timeoutMs: 60_000,
      killGraceMs: 100,
      argv: fakeChild([], "sleep 11"),
    });
    expect(r.timedOut).toBe(true);
  });

  test("the abort signal kills the child (SIGKILL after the grace period if it ignores SIGTERM)", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const start = Date.now();
    const r = await runTaskSubagent({ task: "t" }, {
      sessionLog: "/tmp/x.jsonl",
      signal: ac.signal,
      killGraceMs: 200,
      argv: fakeChild([], "trap '' TERM; sleep 11"),
    });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.success).toBe(false);
    expect(r.exitCode).toBe(130);
    expect(r.summary).toBe("Task was interrupted and killed.");
  });

  // Keep the process alive past the SIGKILL escalations above.
  test("leaves nothing running", async () => {
    await Bun.sleep(300);
    const ps = Bun.spawnSync(["sh", "-c", "ps -eo stat,args | grep 'sleep 11' | grep -v grep | grep -v '^Z' || true"]);
    expect(ps.stdout.toString().trim()).toBe("");
  });

  test("taskSpawnOptions keeps the parsed request between classify and spawn", () => {
    const opts = taskSpawnOptions({ model: "parent/model", cwd: "/", parentLog: "/p.jsonl", inheritFlags: {}, timeoutMs: 0 });
    expect(opts.classifySpawn({ name: "Bash", args: { command: 'gloop --task "x" && ls' } })).toBeNull();
    expect(opts.classifySpawn({ name: "ReadFile", args: { command: 'gloop --task "x"' } })).toBeNull();
    expect(opts.classifySpawn({ name: "Bash", args: { command: 'gloop --task "x" --max-iterations 3' } })).toBe("x");
  });

  test("childInheritFlags: the resolved context window goes to a child on the same model only", () => {
    const parent = { model: "a/m", inheritFlags: { retries: "2" }, contextWindow: 200_000 };
    expect(childInheritFlags(parent, "a/m")).toEqual({ retries: "2", contextWindow: "200000" });
    expect(childInheritFlags(parent, "b/other")).toEqual({ retries: "2" });
    // An explicit window is kept for the same model, dropped for another.
    const explicit = { ...parent, inheritFlags: { contextWindow: "64000" } };
    expect(childInheritFlags(explicit, "a/m")).toEqual({ contextWindow: "64000" });
    expect(childInheritFlags(explicit, "b/other")).toEqual({});
    expect(childInheritFlags({ model: "a/m", inheritFlags: {} }, "a/m")).toEqual({});
  });

  test("formatDuration", () => {
    expect(formatDuration(1_800_000)).toBe("30m");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_600_000)).toBe("1h");
  });
});
