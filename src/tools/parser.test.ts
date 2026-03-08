import { test, expect, describe } from "bun:test";
import { jsonToolCallsToToolCalls } from "./parser.ts";

describe("jsonToolCallsToToolCalls", () => {
  test("converts single tool call with JSON args", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: {
        name: "ReadFile",
        arguments: '{"path":"./README.md"}',
      },
    }]);

    expect(result).toEqual([
      { name: "ReadFile", rawArgs: ["./README.md"] },
    ]);
  });

  test("converts multiple tool calls", () => {
    const result = jsonToolCallsToToolCalls([
      {
        id: "call_1",
        type: "function",
        function: { name: "ReadFile", arguments: '{"path":"a.ts"}' },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "ReadFile", arguments: '{"path":"b.ts"}' },
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].rawArgs).toEqual(["a.ts"]);
    expect(result[1].rawArgs).toEqual(["b.ts"]);
  });

  test("converts tool call with multiple args", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: {
        name: "WriteFile",
        arguments: '{"path":"out.txt","content":"hello world"}',
      },
    }]);

    expect(result).toEqual([
      { name: "WriteFile", rawArgs: ["out.txt", "hello world"] },
    ]);
  });

  test("handles empty arguments object", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: { name: "Reload", arguments: "{}" },
    }]);

    expect(result).toEqual([{ name: "Reload", rawArgs: [] }]);
  });

  test("handles malformed JSON arguments", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: { name: "Bash", arguments: "not json" },
    }]);

    expect(result).toEqual([{ name: "Bash", rawArgs: ["not json"] }]);
  });

  test("handles empty arguments string", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: { name: "Reload", arguments: "" },
    }]);

    expect(result).toEqual([{ name: "Reload", rawArgs: [] }]);
  });

  test("converts numeric and boolean values to strings", () => {
    const result = jsonToolCallsToToolCalls([{
      id: "call_1",
      type: "function",
      function: {
        name: "SetTimeout",
        arguments: '{"timeout":5000,"verbose":true}',
      },
    }]);

    expect(result).toEqual([
      { name: "SetTimeout", rawArgs: ["5000", "true"] },
    ]);
  });
});
