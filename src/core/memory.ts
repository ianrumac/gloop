import { join } from "path";

const MEMORY_DIR = ".gloop";
const MEMORY_FILE = "memory.md";

function getMemoryPath(): string {
  return join(process.cwd(), MEMORY_DIR, MEMORY_FILE);
}

export async function ensureGloopDir(): Promise<void> {
  await Bun.$`mkdir -p ${join(process.cwd(), MEMORY_DIR, "tools")}`.quiet();
}

export async function readMemory(): Promise<string> {
  try {
    const file = Bun.file(getMemoryPath());
    if (await file.exists()) {
      return await file.text();
    }
    return "";
  } catch (_: unknown) {
    // Unreadable memory file — treat as empty
    return "";
  }
}

const MAX_MEMORY_ENTRY_LENGTH = 500;

export function compactMemoryEntry(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  if (trimmed.length <= MAX_MEMORY_ENTRY_LENGTH) {
    return trimmed;
  }

  // Prefer compact one-line memory over failing the run.
  const singleLine = trimmed.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_MEMORY_ENTRY_LENGTH) {
    return singleLine;
  }

  const prefix = "[truncated] ";
  const remaining = MAX_MEMORY_ENTRY_LENGTH - prefix.length - 1; // room for ellipsis
  return `${prefix}${singleLine.slice(0, Math.max(0, remaining)).trimEnd()}…`;
}

export async function appendMemory(content: string): Promise<void> {
  const normalized = compactMemoryEntry(content);
  if (!normalized) return;
  await ensureGloopDir();
  const existing = await readMemory();
  const newContent = existing ? `${existing}\n${normalized}` : normalized;
  await Bun.write(getMemoryPath(), newContent);
}

export async function removeMemory(content: string): Promise<void> {
  const existing = await readMemory();
  if (!existing) return;

  const needle = content.toLowerCase().trim();

  // Try exact substring removal first
  const idx = existing.toLowerCase().indexOf(needle);
  if (idx !== -1) {
    const before = existing.substring(0, idx);
    const after = existing.substring(idx + content.trim().length);
    const cleaned = (before + after).replace(/\n{3,}/g, "\n\n").trim();
    await Bun.write(getMemoryPath(), cleaned);
    return;
  }

  // Fallback: remove lines that contain the content
  const lines = existing.split("\n");
  const filtered = lines.filter((line) => !line.toLowerCase().includes(needle));
  await Bun.write(getMemoryPath(), filtered.join("\n").trim());
}

export interface MemoryToolDef {
  name: string;
  description: string;
  arguments: { name: string; description: string }[];
  path?: string;
}

/** Extract <tool name="..." ...> definitions stored in memory */
export async function extractToolDefsFromMemory(): Promise<MemoryToolDef[]> {
  const content = await readMemory();
  if (!content) return [];

  const defs: MemoryToolDef[] = [];

  // Match: <tool name = "..." description = "..." arguments = {...}>
  // Handles optional commas between attributes and optional path attribute
  const toolDefRe =
    /<tool\s+name\s*=\s*"([^"]+)"\s*,?\s*description\s*=\s*"([^"]+)"\s*,?\s*arguments\s*=\s*(\{[^}]+\})(?:\s*,?\s*path\s*=\s*"([^"]+)")?\s*>/g;

  let match: RegExpExecArray | null;
  while ((match = toolDefRe.exec(content)) !== null) {
    const name = match[1];
    const description = match[2];
    const argsRaw = match[3];
    const path = match[4];

    try {
      // Normalise single quotes to double quotes before parsing
      const argsObj: Record<string, string> = JSON.parse(
        argsRaw.replace(/'/g, '"')
      );
      const args = Object.entries(argsObj).map(([n, desc]) => ({
        name: n,
        description: desc,
      }));
      defs.push({ name, description, arguments: args, path });
    } catch (_: unknown) {
      // Malformed JSON — skip this definition
    }
  }

  return defs;
}
