/**
 * session.ts — Reboot session persistence (save / load) + the
 * `wireRebootHandler` helper that both the interactive (`bin/index.ts`)
 * and headless entry points use.
 */

import { join } from "path";
import type { AIConversation } from "../ai/index.ts";
import type { Message } from "../ai/types.ts";
import type { AgentLoop } from "./core.ts";
import { debugLog } from "./debug.ts";
import { RebootError } from "../tools/builtins.ts";

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

/**
 * Classifier for `AgentLoopOptions.isFatal` that marks a `RebootError` as
 * fatal.  Pass directly to `new AgentLoop({ isFatal: rebootIsFatal, ... })`.
 */
export function rebootIsFatal(error: Error): boolean {
  return error instanceof RebootError;
}

/**
 * Wire up the shared "agent hit a RebootError, save state and restart"
 * handler.  Saves the current conversation session to
 * `.gloop/reboot_session.json` and then invokes the caller-supplied
 * `onRestart` callback, which is responsible for the host-specific
 * cleanup + process termination strategy (Ink unmount + exit 75 for the
 * interactive CLI, Bun.spawn replacement + exit 0 for headless, etc.).
 *
 * The handler only fires on `fatal` events whose error is a `RebootError`;
 * other fatal errors are ignored so callers can layer additional
 * classifiers if they need to.  The loop has already stopped processing
 * by the time `onRestart` runs — do not enqueue more messages.
 */
export function wireRebootHandler(
  agent: AgentLoop,
  onRestart: (reason: string) => void | Promise<void>,
): void {
  agent.on("fatal", (event) => {
    if (!(event.error instanceof RebootError)) return;
    const reason = event.error.reason;
    void (async () => {
      await saveRebootSession(agent.convo, reason);
      debugLog("REBOOT", `Restarting: ${reason}`);
      await onRestart(reason);
    })();
  });
}
