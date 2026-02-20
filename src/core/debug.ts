import { join } from "path";
import { appendFileSync, writeFileSync } from "fs";

const LOG_PATH = join(process.cwd(), ".gloop", "debug.log");

let enabled = false;

export function enableDebug(): void {
  enabled = true;
  // Start fresh each session
  writeFileSync(LOG_PATH, `=== gloop debug log — ${new Date().toISOString()} ===\n\n`);
}

export function isDebug(): boolean {
  return enabled;
}

const HEAD_TAIL_LENGTH = 200;
const MAX_CONTENT_LENGTH = HEAD_TAIL_LENGTH * 2;

export function debugLog(label: string, content: string): void {
  if (!enabled) return;
  const timestamp = new Date().toISOString();
  const truncated = content.length > MAX_CONTENT_LENGTH
    ? content.substring(0, HEAD_TAIL_LENGTH) +
      `\n... (truncated, ${content.length} chars total) ...\n` +
      content.substring(content.length - HEAD_TAIL_LENGTH)
    : content;
  const entry = `--- [${timestamp}] ${label} ---\n${truncated}\n\n`;
  appendFileSync(LOG_PATH, entry);
}

export function debugLogRaw(label: string, content: string): void {
  if (!enabled) return;
  const timestamp = new Date().toISOString();
  const entry = `--- [${timestamp}] ${label} ---\n${content}\n\n`;
  appendFileSync(LOG_PATH, entry);
}
