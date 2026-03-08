import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { compactMemoryEntry, appendMemory, readMemory, removeMemory, extractToolDefsFromMemory } from "./memory.ts";

// ---------------------------------------------------------------------------
// compactMemoryEntry (pure — no I/O)
// ---------------------------------------------------------------------------

describe("compactMemoryEntry", () => {
  test("returns empty string for blank input", () => {
    expect(compactMemoryEntry("")).toBe("");
    expect(compactMemoryEntry("   ")).toBe("");
  });

  test("trims whitespace", () => {
    expect(compactMemoryEntry("  hello  ")).toBe("hello");
  });

  test("passes through short entries unchanged", () => {
    const short = "User prefers dark mode";
    expect(compactMemoryEntry(short)).toBe(short);
  });

  test("short multiline entries are kept as-is (within limit)", () => {
    const multiline = "line one\n  line two\n  line three";
    const result = compactMemoryEntry(multiline);
    // Under 500 chars, so trimmed but not collapsed
    expect(result).toBe(multiline);
  });

  test("long multiline collapses to single line if that fits within limit", () => {
    // Create a multiline string that exceeds 500 when multiline but fits when collapsed
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} with some content`);
    const multiline = lines.join("\n    "); // lots of whitespace padding
    // Ensure it's over 500 chars
    expect(multiline.length).toBeGreaterThan(500);
    const result = compactMemoryEntry(multiline);
    expect(result).not.toContain("\n");
    expect(result.length).toBeLessThanOrEqual(500);
  });

  test("truncates with prefix when too long", () => {
    const long = "a".repeat(600);
    const result = compactMemoryEntry(long);
    expect(result.startsWith("[truncated] ")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result.endsWith("…")).toBe(true);
  });

  test("exactly 500 chars passes through", () => {
    const exact = "x".repeat(500);
    expect(compactMemoryEntry(exact)).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// File-based tests — use a temp directory
// ---------------------------------------------------------------------------

const TEST_DIR = join(import.meta.dirname, "__test_memory_tmp__");
let originalCwd: string;

describe("memory file operations", () => {
  beforeEach(async () => {
    originalCwd = process.cwd();
    await Bun.$`mkdir -p ${TEST_DIR}`.quiet();
    process.chdir(TEST_DIR);
    // Clean any existing memory
    await Bun.$`rm -rf ${join(TEST_DIR, ".gloop")}`.quiet();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await Bun.$`rm -rf ${TEST_DIR}`.quiet();
  });

  test("readMemory returns empty string when no file exists", async () => {
    expect(await readMemory()).toBe("");
  });

  test("appendMemory creates file and writes content", async () => {
    await appendMemory("remember this");
    const content = await readMemory();
    expect(content).toBe("remember this");
  });

  test("appendMemory appends to existing content", async () => {
    await appendMemory("first");
    await appendMemory("second");
    const content = await readMemory();
    expect(content).toBe("first\nsecond");
  });

  test("appendMemory skips empty content", async () => {
    await appendMemory("");
    expect(await readMemory()).toBe("");
  });

  test("removeMemory — exact substring removal", async () => {
    await appendMemory("keep this");
    await appendMemory("delete me");
    await appendMemory("also keep");

    await removeMemory("delete me");
    const content = await readMemory();
    expect(content).toContain("keep this");
    expect(content).toContain("also keep");
    expect(content).not.toContain("delete me");
  });

  test("removeMemory — case insensitive", async () => {
    await appendMemory("User prefers DARK mode");
    await removeMemory("user prefers dark mode");
    const content = await readMemory();
    expect(content).not.toContain("DARK");
  });

  test("removeMemory — line-based fallback", async () => {
    await appendMemory("line with keyword foo inside");
    await appendMemory("clean line");

    await removeMemory("foo");
    const content = await readMemory();
    expect(content).not.toContain("foo");
    expect(content).toContain("clean line");
  });

  test("removeMemory does nothing when memory is empty", async () => {
    await removeMemory("anything");
    expect(await readMemory()).toBe("");
  });

  test("extractToolDefsFromMemory returns empty when no defs", async () => {
    await appendMemory("just some notes");
    const defs = await extractToolDefsFromMemory();
    expect(defs).toEqual([]);
  });

  test("extractToolDefsFromMemory parses tool definition", async () => {
    await appendMemory(
      `<tool name="MyTool" description="Does stuff" arguments={"input": "the input"}>`
    );
    const defs = await extractToolDefsFromMemory();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("MyTool");
    expect(defs[0].description).toBe("Does stuff");
    expect(defs[0].arguments).toEqual([{ name: "input", description: "the input" }]);
  });

  test("extractToolDefsFromMemory handles single quotes in args", async () => {
    await appendMemory(
      `<tool name="Quoted" description="test" arguments={'key': 'value'}>`
    );
    const defs = await extractToolDefsFromMemory();
    expect(defs).toHaveLength(1);
    expect(defs[0].arguments[0].name).toBe("key");
  });

  test("extractToolDefsFromMemory handles path attribute", async () => {
    await appendMemory(
      `<tool name="WithPath" description="desc" arguments={"arg": "desc"} path="/custom/path.ts">`
    );
    const defs = await extractToolDefsFromMemory();
    expect(defs).toHaveLength(1);
    expect(defs[0].path).toBe("/custom/path.ts");
  });

  test("extractToolDefsFromMemory skips malformed JSON", async () => {
    await appendMemory(
      `<tool name="Bad" description="bad" arguments={not valid json}>`
    );
    const defs = await extractToolDefsFromMemory();
    expect(defs).toEqual([]);
  });
});
