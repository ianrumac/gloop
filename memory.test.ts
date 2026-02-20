import { expect, test } from "bun:test";
import { compactMemoryEntry } from "./src/core/memory.ts";

test("compactMemoryEntry keeps short entries unchanged", () => {
  const input = "Keep this memory note.";
  expect(compactMemoryEntry(input)).toBe(input);
});

test("compactMemoryEntry truncates oversized content", () => {
  const input = "A".repeat(10_000);
  const compacted = compactMemoryEntry(input);
  expect(compacted.length).toBeLessThanOrEqual(500);
  expect(compacted.startsWith("[truncated] ")).toBe(true);
});

test("compactMemoryEntry compacts multiline dumps", () => {
  const input = `${"line output\n".repeat(1000)}tail`;
  const compacted = compactMemoryEntry(input);
  expect(compacted.length).toBeLessThanOrEqual(500);
  expect(compacted.includes("\n")).toBe(false);
});
