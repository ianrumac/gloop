/**
 * File-backed memory helper for gloop-loop.
 *
 * **The lib itself does not default to file-backed memory.**  If you
 * construct an `AgentLoop` without providing `remember` / `forget`, the
 * actor uses no-ops and just emits `memory` events — nothing is written
 * to disk.
 *
 * To opt into persistent memory, call `createFileMemory()` and pass the
 * returned `remember` / `forget` into your `AgentLoopOptions`:
 *
 *     import { AgentLoop, createFileMemory, OpenRouterProvider } from "@hypen-space/gloop-loop";
 *
 *     const memory = createFileMemory();                  // .gloop/memory.md in cwd
 *     const memory = createFileMemory({ dir: ".notes" }); // .notes/memory.md
 *
 *     const agent = new AgentLoop({
 *       provider,
 *       model,
 *       remember: memory.remember,
 *       forget:   memory.forget,
 *     });
 *
 * The top-level `appendMemory` / `removeMemory` / `readMemory` exports are
 * thin wrappers around a default-config `createFileMemory()` — kept for
 * back-compat with existing callers.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ============================================================================
// Config
// ============================================================================

export interface FileMemoryOptions {
  /** Directory (relative to cwd) containing the memory file.  Default: `.gloop`. */
  dir?: string;
  /** Memory file name.  Default: `memory.md`. */
  file?: string;
  /** Max length of a single entry before truncation.  Default: 500. */
  maxEntryLength?: number;
}

export interface FileMemory {
  remember(content: string): Promise<void>;
  forget(content: string): Promise<void>;
  read(): Promise<string>;
}

interface ResolvedConfig {
  dir: string;
  file: string;
  maxEntryLength: number;
}

const DEFAULTS: ResolvedConfig = {
  dir: ".gloop",
  file: "memory.md",
  maxEntryLength: 500,
};

function resolve(opts: FileMemoryOptions = {}): ResolvedConfig {
  return {
    dir: opts.dir ?? DEFAULTS.dir,
    file: opts.file ?? DEFAULTS.file,
    maxEntryLength: opts.maxEntryLength ?? DEFAULTS.maxEntryLength,
  };
}

// ============================================================================
// Low-level operations
// ============================================================================

function getPath(cfg: ResolvedConfig): string {
  return join(process.cwd(), cfg.dir, cfg.file);
}

async function ensureDir(cfg: ResolvedConfig): Promise<void> {
  await mkdir(join(process.cwd(), cfg.dir), { recursive: true });
}

async function readFileSafe(cfg: ResolvedConfig): Promise<string> {
  try {
    return await readFile(getPath(cfg), "utf-8");
  } catch {
    return "";
  }
}

function compactEntry(content: string, maxLen: number): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLen) return trimmed;

  const singleLine = trimmed.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;

  const prefix = "[truncated] ";
  const remaining = maxLen - prefix.length - 1;
  return `${prefix}${singleLine.slice(0, Math.max(0, remaining)).trimEnd()}…`;
}

async function append(content: string, cfg: ResolvedConfig): Promise<void> {
  const normalized = compactEntry(content, cfg.maxEntryLength);
  if (!normalized) return;
  await ensureDir(cfg);
  const existing = await readFileSafe(cfg);
  const newContent = existing ? `${existing}\n${normalized}` : normalized;
  await writeFile(getPath(cfg), newContent, "utf-8");
}

async function remove(content: string, cfg: ResolvedConfig): Promise<void> {
  const existing = await readFileSafe(cfg);
  if (!existing) return;

  const needle = content.toLowerCase().trim();

  // Try exact substring removal first
  const idx = existing.toLowerCase().indexOf(needle);
  if (idx !== -1) {
    const before = existing.substring(0, idx);
    const after = existing.substring(idx + content.trim().length);
    const cleaned = (before + after).replace(/\n{3,}/g, "\n\n").trim();
    await writeFile(getPath(cfg), cleaned, "utf-8");
    return;
  }

  // Fallback: remove lines containing the content
  const lines = existing.split("\n");
  const filtered = lines.filter((line) => !line.toLowerCase().includes(needle));
  await writeFile(getPath(cfg), filtered.join("\n").trim(), "utf-8");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create an opt-in file-backed memory bundle.  Pass the returned
 * `remember` / `forget` into `AgentLoopOptions`.
 */
export function createFileMemory(opts?: FileMemoryOptions): FileMemory {
  const cfg = resolve(opts);
  return {
    remember: (content) => append(content, cfg),
    forget: (content) => remove(content, cfg),
    read: () => readFileSafe(cfg),
  };
}

/**
 * Append a memory entry to `.gloop/memory.md` in the current working
 * directory.  Thin wrapper around `createFileMemory()` with default config.
 */
export async function appendMemory(content: string): Promise<void> {
  return append(content, DEFAULTS);
}

/**
 * Remove a memory entry from `.gloop/memory.md` in the current working
 * directory.  Thin wrapper around `createFileMemory()` with default config.
 */
export async function removeMemory(content: string): Promise<void> {
  return remove(content, DEFAULTS);
}

/**
 * Read the contents of `.gloop/memory.md` in the current working directory.
 * Thin wrapper around `createFileMemory()` with default config.
 */
export async function readMemory(): Promise<string> {
  return readFileSafe(DEFAULTS);
}
