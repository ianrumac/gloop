/**
 * Default memory implementation — portable file-backed memory.
 *
 * Stores notes in `.gloop/memory.md` in the current working directory.
 * Uses `node:fs/promises` — works on Node >= 18 and Bun.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_DIR = ".gloop";
const MEMORY_FILE = "memory.md";
const MAX_ENTRY_LENGTH = 500;

function getMemoryPath(): string {
  return join(process.cwd(), MEMORY_DIR, MEMORY_FILE);
}

async function ensureDir(): Promise<void> {
  await mkdir(join(process.cwd(), MEMORY_DIR), { recursive: true });
}

async function read(): Promise<string> {
  try {
    return await readFile(getMemoryPath(), "utf-8");
  } catch {
    return "";
  }
}

function compactEntry(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (trimmed.length <= MAX_ENTRY_LENGTH) return trimmed;

  const singleLine = trimmed.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_ENTRY_LENGTH) return singleLine;

  const prefix = "[truncated] ";
  const remaining = MAX_ENTRY_LENGTH - prefix.length - 1;
  return `${prefix}${singleLine.slice(0, Math.max(0, remaining)).trimEnd()}…`;
}

export async function appendMemory(content: string): Promise<void> {
  const normalized = compactEntry(content);
  if (!normalized) return;
  await ensureDir();
  const existing = await read();
  const newContent = existing ? `${existing}\n${normalized}` : normalized;
  await writeFile(getMemoryPath(), newContent, "utf-8");
}

export async function removeMemory(content: string): Promise<void> {
  const existing = await read();
  if (!existing) return;

  const needle = content.toLowerCase().trim();

  // Try exact substring removal first
  const idx = existing.toLowerCase().indexOf(needle);
  if (idx !== -1) {
    const before = existing.substring(0, idx);
    const after = existing.substring(idx + content.trim().length);
    const cleaned = (before + after).replace(/\n{3,}/g, "\n\n").trim();
    await writeFile(getMemoryPath(), cleaned, "utf-8");
    return;
  }

  // Fallback: remove lines containing the content
  const lines = existing.split("\n");
  const filtered = lines.filter((line) => !line.toLowerCase().includes(needle));
  await writeFile(getMemoryPath(), filtered.join("\n").trim(), "utf-8");
}

export async function readMemory(): Promise<string> {
  return read();
}
