/**
 * session.ts — Reboot session persistence (save / load)
 *
 * Pure file I/O, no agent or UI dependencies.
 */

import { join } from "path";
import type { AIConversation } from "../ai/index.ts";
import type { Message } from "../ai/types.ts";
import { debugLog } from "./debug.ts";

const REBOOT_SESSION_PATH = join(process.cwd(), ".gloop", "reboot_session.json");

export interface RebootSession {
  history: Message[];
  reason: string;
}

export async function saveRebootSession(convo: AIConversation, reason: string): Promise<void> {
  const session = {
    history: convo.getHistory(),
    reason,
    timestamp: new Date().toISOString(),
  };
  await Bun.write(REBOOT_SESSION_PATH, JSON.stringify(session, null, 2));
  debugLog("REBOOT", `Session saved: ${reason}`);
}

export async function loadRebootSession(): Promise<RebootSession | null> {
  const file = Bun.file(REBOOT_SESSION_PATH);
  if (!(await file.exists())) return null;
  try {
    const session = await file.json();
    const { unlinkSync } = await import("fs");
    unlinkSync(REBOOT_SESSION_PATH);
    return session as RebootSession;
  } catch (_: unknown) {
    // Corrupt/unreadable session file — start fresh
    return null;
  }
}
