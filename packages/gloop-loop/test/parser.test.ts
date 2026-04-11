import { test, expect, describe } from "bun:test";
import { jsonToolCallsToToolCalls } from "../src/tools/parser.js";
import { ToolRegistry } from "../src/tools/registry.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: "ReadFile",
    description: "Read a file",
    arguments: [{ name: "path", description: "path" }],
    execute: async () => "",
  });
  r.register({
    name: "WriteFile",
    description: "Write a file",
    arguments: [
      { name: "path", description: "path" },
      { name: "content", description: "content" },
    ],
    execute: async () => "",
  });
  r.register({
    name: "Edit",
    description: "Edit file",
    arguments: [
      { name: "file_path", description: "fp" },
      { name: "old_string", description: "o" },
      { name: "new_string", description: "n" },
    ],
    execute: async () => "",
  });
  r.register({
    name: "CompleteTask",
    description: "done",
    arguments: [{ name: "summary", description: "s" }],
    execute: async () => "",
  });
  r.register({
    name: "Reload",
    description: "reload",
    arguments: [],
    execute: async () => "",
  });
  r.register({
    name: "Bash",
    description: "shell",
    arguments: [{ name: "command", description: "cmd" }],
    execute: async () => "",
  });
  r.register({
    name: "SetTimeout",
    description: "timeout",
    arguments: [
      { name: "timeout", description: "ms" },
      { name: "verbose", description: "v" },
    ],
    execute: async () => "",
  });
  return r;
}

// ---------------------------------------------------------------------------

describe("jsonToolCallsToToolCalls", () => {
  test("single tool call with one arg", () => {
    const result = jsonToolCallsToToolCalls(
      [{
        id: "call_1",
        type: "function",
        function: { name: "ReadFile", arguments: '{"path":"./README.md"}' },
      }],
      makeRegistry(),
    );
    expect(result).toEqual([{ name: "ReadFile", args: { path: "./README.md" } }]);
  });

  test("multiple tool calls", () => {
    const result = jsonToolCallsToToolCalls(
      [
        { id: "c1", type: "function", function: { name: "ReadFile", arguments: '{"path":"a.ts"}' } },
        { id: "c2", type: "function", function: { name: "ReadFile", arguments: '{"path":"b.ts"}' } },
      ],
      makeRegistry(),
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.args).toEqual({ path: "a.ts" });
    expect(result[1]!.args).toEqual({ path: "b.ts" });
  });

  test("two-arg tool in schema order", () => {
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: { name: "WriteFile", arguments: '{"path":"out.txt","content":"hi"}' },
      }],
      makeRegistry(),
    );
    expect(result[0]!.args).toEqual({ path: "out.txt", content: "hi" });
  });

  test("two-arg tool with keys REVERSED — registry still maps them by name", () => {
    // Previously this was a subtle bug: the parser walked Object.values and
    // would have given ["hi", "out.txt"], writing "out.txt" into a file
    // called "hi".  Now the parser keys by name so order doesn't matter.
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: { name: "WriteFile", arguments: '{"content":"hi","path":"out.txt"}' },
      }],
      makeRegistry(),
    );
    expect(result[0]!.args).toEqual({ path: "out.txt", content: "hi" });
  });

  test("three-arg tool with keys scrambled", () => {
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: {
          name: "Edit",
          arguments: '{"new_string":"B","file_path":"/tmp/f.ts","old_string":"A"}',
        },
      }],
      makeRegistry(),
    );
    expect(result[0]!.args).toEqual({
      file_path: "/tmp/f.ts",
      old_string: "A",
      new_string: "B",
    });
  });

  test("empty args object produces empty args record", () => {
    // Must be {} so downstream `args.summary ?? default` fallbacks fire.
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: { name: "CompleteTask", arguments: "{}" },
      }],
      makeRegistry(),
    );
    expect(result[0]!.args).toEqual({});
  });

  test("only present args are included (missing ones stay absent)", () => {
    // Previously this test required leading empty-string slots; the named
    // record just omits missing keys so downstream `??` fallbacks work.
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: { name: "Edit", arguments: '{"new_string":"B"}' },
      }],
      makeRegistry(),
    );
    expect(result[0]!.args).toEqual({ new_string: "B" });
  });

  test("numeric and boolean values are stringified", () => {
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: { name: "SetTimeout", arguments: '{"timeout":5000,"verbose":true}' },
      }],
      makeRegistry(),
    );
    expect(result[0]!.args).toEqual({ timeout: "5000", verbose: "true" });
  });

  test("malformed JSON falls through to the tool's first declared arg", () => {
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: { name: "Bash", arguments: "not json" },
      }],
      makeRegistry(),
    );
    expect(result[0]!.args).toEqual({ command: "not json" });
  });

  test("empty arguments string yields empty args record", () => {
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: { name: "Reload", arguments: "" },
      }],
      makeRegistry(),
    );
    expect(result[0]!.args).toEqual({});
  });

  test("unknown tool name produces empty args (caller sees clean error)", () => {
    const result = jsonToolCallsToToolCalls(
      [{
        id: "c1",
        type: "function",
        function: { name: "Mystery", arguments: '{"a":"x","b":"y"}' },
      }],
      makeRegistry(),
    );
    expect(result).toEqual([{ name: "Mystery", args: {} }]);
  });
});
