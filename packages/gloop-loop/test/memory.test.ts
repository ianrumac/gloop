import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  appendMemory,
  removeMemory,
  readMemory,
  createFileMemory,
} from "../src/defaults/memory.js";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Memory tests — use a temp directory to avoid polluting the project
// ---------------------------------------------------------------------------

let originalCwd: string;
let tempDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempDir = join(tmpdir(), `gloop-test-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

function memoryPath(): string {
  return join(tempDir, ".gloop", "memory.md");
}

describe("memory", () => {
  describe("appendMemory", () => {
    test("creates .gloop/memory.md and writes content", async () => {
      await appendMemory("first note");

      const content = await readFile(memoryPath(), "utf-8");
      expect(content).toBe("first note");
    });

    test("appends to existing content with newline separator", async () => {
      await appendMemory("note one");
      await appendMemory("note two");

      const content = await readFile(memoryPath(), "utf-8");
      expect(content).toBe("note one\nnote two");
    });

    test("skips empty/whitespace content", async () => {
      await appendMemory("");
      await appendMemory("   ");
      await appendMemory("\n\t");

      const content = await readMemory();
      expect(content).toBe("");
    });

    test("truncates entries longer than 500 chars", async () => {
      const longContent = "x".repeat(600);
      await appendMemory(longContent);

      const content = await readFile(memoryPath(), "utf-8");
      expect(content.length).toBeLessThanOrEqual(500);
      expect(content).toContain("[truncated]");
    });

    test("compacts multiline content to single line when under max length", async () => {
      // Content must exceed MAX_ENTRY_LENGTH (500) as multiline but fit when compacted
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
      const multiline = lines.join("\n");
      // Multiline is >500 chars, but single-line version should be <=500
      expect(multiline.length).toBeGreaterThan(500);
      await appendMemory(multiline);

      const content = await readFile(memoryPath(), "utf-8");
      expect(content).not.toContain("\n");
      expect(content.length).toBeLessThanOrEqual(500);
    });

    test("trims whitespace from content", async () => {
      await appendMemory("  padded note  ");

      const content = await readFile(memoryPath(), "utf-8");
      expect(content).toBe("padded note");
    });
  });

  describe("removeMemory", () => {
    test("removes exact substring match", async () => {
      await appendMemory("keep this");
      await appendMemory("remove this");
      await appendMemory("also keep");

      await removeMemory("remove this");

      const content = await readMemory();
      expect(content).toContain("keep this");
      expect(content).toContain("also keep");
      expect(content).not.toContain("remove this");
    });

    test("case-insensitive matching", async () => {
      await appendMemory("Important Note");

      await removeMemory("important note");

      const content = await readMemory();
      expect(content).toBe("");
    });

    test("removes lines containing the content when no exact match", async () => {
      await appendMemory("the cat sat on the mat");
      await appendMemory("the dog ran in the park");

      await removeMemory("cat");

      const content = await readMemory();
      expect(content).not.toContain("cat");
      expect(content).toContain("dog");
    });

    test("no-op when memory file does not exist", async () => {
      // Should not throw
      await removeMemory("nonexistent");
    });

    test("no-op when content is not found", async () => {
      await appendMemory("existing note");

      await removeMemory("completely different");

      const content = await readMemory();
      expect(content).toBe("existing note");
    });

    test("cleans up extra blank lines after removal", async () => {
      await appendMemory("a");
      await appendMemory("b");
      await appendMemory("c");

      await removeMemory("b");

      const content = await readMemory();
      // Should not have triple newlines
      expect(content).not.toContain("\n\n\n");
    });
  });

  describe("readMemory", () => {
    test("returns empty string when no memory file", async () => {
      const content = await readMemory();
      expect(content).toBe("");
    });

    test("returns file content when it exists", async () => {
      await appendMemory("stored note");

      const content = await readMemory();
      expect(content).toBe("stored note");
    });

    test("returns accumulated content from multiple appends", async () => {
      await appendMemory("first");
      await appendMemory("second");
      await appendMemory("third");

      const content = await readMemory();
      expect(content).toBe("first\nsecond\nthird");
    });
  });

  describe("createFileMemory", () => {
    test("defaults write to .gloop/memory.md just like the top-level helpers", async () => {
      const memory = createFileMemory();
      await memory.remember("hello from factory");

      const content = await readFile(join(tempDir, ".gloop", "memory.md"), "utf-8");
      expect(content).toBe("hello from factory");
    });

    test("custom dir and file are respected", async () => {
      const memory = createFileMemory({ dir: ".notes", file: "custom.md" });
      await memory.remember("custom note");

      const content = await readFile(join(tempDir, ".notes", "custom.md"), "utf-8");
      expect(content).toBe("custom note");

      // Default location should NOT have been touched.
      await expect(readFile(join(tempDir, ".gloop", "memory.md"), "utf-8"))
        .rejects.toThrow();
    });

    test("custom maxEntryLength truncates at the configured length", async () => {
      const memory = createFileMemory({ dir: ".short", maxEntryLength: 20 });
      await memory.remember("x".repeat(100));

      const content = await memory.read();
      expect(content.length).toBeLessThanOrEqual(20);
      expect(content).toContain("[truncated]");
    });

    test("forget removes content from a custom-config memory", async () => {
      const memory = createFileMemory({ dir: ".notes" });
      await memory.remember("keep");
      await memory.remember("remove me");
      await memory.remember("also keep");

      await memory.forget("remove me");

      const content = await memory.read();
      expect(content).toContain("keep");
      expect(content).toContain("also keep");
      expect(content).not.toContain("remove me");
    });

    test("two instances with different dirs are independent", async () => {
      const a = createFileMemory({ dir: ".a" });
      const b = createFileMemory({ dir: ".b" });

      await a.remember("only in a");
      await b.remember("only in b");

      expect(await a.read()).toBe("only in a");
      expect(await b.read()).toBe("only in b");
    });
  });
});
