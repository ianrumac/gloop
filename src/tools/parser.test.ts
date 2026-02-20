import { test, expect, describe } from "bun:test";
import { parseResponse, parseToolCall, parseArguments } from "./parser.ts";

describe("parseArguments", () => {
  test("single double-quoted argument", () => {
    expect(parseArguments('"./README.md"')).toEqual(["./README.md"]);
  });

  test("two double-quoted arguments", () => {
    expect(parseArguments('"./file.ts", "hello world"')).toEqual([
      "./file.ts",
      "hello world",
    ]);
  });

  test("single-quoted argument", () => {
    expect(parseArguments("'./README.md'")).toEqual(["./README.md"]);
  });

  test("backtick-quoted multiline argument", () => {
    const input = '`line1\nline2\nline3`';
    expect(parseArguments(input)).toEqual(["line1\nline2\nline3"]);
  });

  test("escape sequences in double quotes", () => {
    expect(parseArguments('"hello\\nworld"')).toEqual(["hello\nworld"]);
    expect(parseArguments('"tab\\there"')).toEqual(["tab\there"]);
    expect(parseArguments('"back\\\\slash"')).toEqual(["back\\slash"]);
  });

  test("empty argument list", () => {
    expect(parseArguments("")).toEqual([]);
  });

  test("mixed quote styles", () => {
    expect(parseArguments(`"double", 'single'`)).toEqual([
      "double",
      "single",
    ]);
  });

  test("named kwargs with double quotes", () => {
    expect(parseArguments('path="./README.md"')).toEqual(["./README.md"]);
  });

  test("named kwargs with multiple args", () => {
    expect(
      parseArguments('path="./file.ts", content="hello world"')
    ).toEqual(["./file.ts", "hello world"]);
  });

  test("named kwargs mixed with positional", () => {
    expect(parseArguments('"positional", name="named"')).toEqual([
      "positional",
      "named",
    ]);
  });

  test("named kwargs with single quotes", () => {
    expect(parseArguments("command='ls -la'")).toEqual(["ls -la"]);
  });

  test("named kwargs with spaces around =", () => {
    expect(parseArguments('path = "./file.ts"')).toEqual(["./file.ts"]);
  });

  test("named kwargs with colon syntax", () => {
    expect(parseArguments('command: "ls -la"')).toEqual(["ls -la"]);
  });

  test("named kwargs with colon and multiple args", () => {
    expect(
      parseArguments('path: "./file.ts", content: "hello"')
    ).toEqual(["./file.ts", "hello"]);
  });
});

describe("parseToolCall", () => {
  test("no-arg tool call", () => {
    expect(parseToolCall("Reload()")).toEqual({
      name: "Reload",
      rawArgs: [],
    });
  });

  test("single-arg tool call", () => {
    expect(parseToolCall('ReadFile("./README.md")')).toEqual({
      name: "ReadFile",
      rawArgs: ["./README.md"],
    });
  });

  test("multi-arg tool call", () => {
    expect(
      parseToolCall('WriteFile("./out.txt", "file content here")')
    ).toEqual({
      name: "WriteFile",
      rawArgs: ["./out.txt", "file content here"],
    });
  });

  test("named kwargs tool call", () => {
    expect(
      parseToolCall('WriteFile(path="./out.txt", content="hello")')
    ).toEqual({
      name: "WriteFile",
      rawArgs: ["./out.txt", "hello"],
    });
  });

  test("named kwargs tool call with single arg", () => {
    expect(
      parseToolCall('ReadFile(path="./README.md")')
    ).toEqual({
      name: "ReadFile",
      rawArgs: ["./README.md"],
    });
  });

  test("returns null for invalid format", () => {
    expect(parseToolCall("not a tool call")).toBeNull();
    expect(parseToolCall("")).toBeNull();
  });
});

describe("parseResponse", () => {
  test("plain text with no tags", () => {
    const result = parseResponse("Hello, world!");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.remembers).toHaveLength(0);
    expect(result.forgets).toHaveLength(0);
    expect(result.cleanText).toBe("Hello, world!");
  });

  test("single tool call", () => {
    const text = 'Let me read that. <tool>ReadFile("./README.md")</tool>';
    const result = parseResponse(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("ReadFile");
    expect(result.toolCalls[0].rawArgs).toEqual(["./README.md"]);
    expect(result.cleanText).toBe("Let me read that.");
  });

  test("multiple tool calls", () => {
    const text =
      '<tool>ReadFile("a.ts")</tool> and <tool>ReadFile("b.ts")</tool>';
    const result = parseResponse(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].rawArgs).toEqual(["a.ts"]);
    expect(result.toolCalls[1].rawArgs).toEqual(["b.ts"]);
  });

  test("tools block with multiple tool calls", () => {
    const text = `Here:
<tools>
  <tool>ReadFile("a.ts")</tool>
  <tool>Bash("ls")</tool>
</tools>`;
    const result = parseResponse(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("ReadFile");
    expect(result.toolCalls[1].name).toBe("Bash");
  });

  test("tools block with unclosed closing tag", () => {
    // The spec shows <tools>...<tools> as the closing tag (no slash)
    const text = `<tools>
  <tool>Reload()</tool>
<tools>`;
    const result = parseResponse(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("Reload");
  });

  test("remember block", () => {
    const text =
      "Sure! <remember>The answer is 42</remember> I'll remember that.";
    const result = parseResponse(text);
    expect(result.remembers).toEqual(["The answer is 42"]);
    expect(result.toolCalls).toHaveLength(0);
  });

  test("forget block", () => {
    const text = "OK. <forget>The answer is 42</forget> Forgotten.";
    const result = parseResponse(text);
    expect(result.forgets).toEqual(["The answer is 42"]);
  });

  test("tool call + remember in same response", () => {
    const text = `<tool>ReadFile("x.ts")</tool>
<remember>x.ts contains the main logic</remember>`;
    const result = parseResponse(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.remembers).toHaveLength(1);
  });

  test("tools block with remember inside", () => {
    const text = `<tools>
  <tool>ReadFile("./README.md")</tool>
  <remember>Always update readme</remember>
</tools>`;
    const result = parseResponse(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.remembers).toEqual(["Always update readme"]);
  });

  test("tool definition inside remember", () => {
    const text = `<remember><tool name = "MyTool" description = "Does stuff" arguments = { "x": "the x value" }></tool></remember>`;
    const result = parseResponse(text);
    // The whole thing is a remember block
    expect(result.remembers).toHaveLength(1);
    expect(result.remembers[0]).toContain('name = "MyTool"');
  });

  test("codeblock-wrapped tools block", () => {
    const text = "```\n<tools>\n  <tool>Bash(\"ls\")</tool>\n</tools>\n```";
    const result = parseResponse(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("Bash");
  });
});
