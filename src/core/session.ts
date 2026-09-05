/**
 * session.ts — Session persistence on top of gloop-loop's event log.
 *
 * Every gloop run appends its events to `.gloop/sessions/<timestamp>.jsonl`.
 * That file IS the session: history, system prompt, tool calls, memory ops,
 * confirmations — all of it — and `AgentLoop.resume` rebuilds the agent
 * from it (rolling back to the last turn boundary and re-queueing whatever
 * was cut off).
 *
 * Reboot (the agent modified its own code and asked to restart) writes a
 * tiny pointer file, `.gloop/reboot_session.json`, naming the log to resume
 * plus the reason.  The relaunched process picks it up, deletes it, and
 * resumes from that log.  `gloop --resume [path]` does the same by hand.
 */

import { join } from "path";
import { readdirSync } from "fs";
import {
  createJsonlEventStore,
  isEphemeralEvent,
  type JsonlEventStore,
} from "@hypen-space/gloop-loop";
import type { AgentLoop } from "./core.ts";
import { debugLog } from "./debug.ts";
import { RebootError } from "../tools/builtins.ts";

const GLOOP_DIR = () => join(process.cwd(), ".gloop");
const SESSIONS_DIR = () => join(GLOOP_DIR(), "sessions");
const REBOOT_SESSION_PATH = () => join(GLOOP_DIR(), "reboot_session.json");

export interface RebootSession {
  /** Why the agent asked to restart. */
  reason: string;
  /** Path of the JSONL event log to resume from. */
  log: string;
  timestamp?: string;
}

/**
 * A fresh session log path: `.gloop/sessions/<ISO timestamp>[-label].jsonl`.
 * Spawned task subagents use a label so their logs sit next to the parent's.
 */
export function newSessionLogPath(now: Date = new Date(), label?: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = label ? `-${label.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";
  return join(SESSIONS_DIR(), `${stamp}${suffix}.jsonl`);
}

/** The most recently created session log, or null if none exist. */
export function latestSessionLogPath(): string | null {
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR()).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  names.sort();
  return join(SESSIONS_DIR(), names[names.length - 1]!);
}

/**
 * Open (or create) the JSONL store for a session log.  Progress-only events
 * (`stream_chunk`, `busy`, `idle`, `queue_changed`) are not persisted —
 * they carry no state and would dwarf the file.
 */
export function openSessionStore(path: string): JsonlEventStore {
  return createJsonlEventStore(path, { filter: (e) => !isEphemeralEvent(e) });
}

/**
 * Write the reboot pointer.  Pass `flush` (normally `agent.flush`) so the
 * log is fully on disk before the pointer that references it exists.
 */
export async function saveRebootSession(
  logPath: string,
  reason: string,
  flush?: () => Promise<void>,
): Promise<void> {
  if (flush) await flush();
  const session: RebootSession = { reason, log: logPath, timestamp: new Date().toISOString() };
  await Bun.write(REBOOT_SESSION_PATH(), JSON.stringify(session, null, 2));
  debugLog("REBOOT", `Session saved: ${reason} → ${logPath}`);
}

/** Read and delete the reboot pointer.  Null when absent or corrupt. */
export async function loadRebootSession(): Promise<RebootSession | null> {
  const file = Bun.file(REBOOT_SESSION_PATH());
  if (!(await file.exists())) return null;
  try {
    const session = (await file.json()) as Partial<RebootSession>;
    const { unlinkSync } = await import("fs");
    unlinkSync(REBOOT_SESSION_PATH());
    if (typeof session.log !== "string" || typeof session.reason !== "string") return null;
    return { reason: session.reason, log: session.log, timestamp: session.timestamp };
  } catch (_: unknown) {
    // Corrupt/unreadable pointer — start fresh
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
 * Wire up the shared "agent hit a RebootError, persist and restart" handler.
 * Flushes the event log, writes the reboot pointer at `logPath`, then invokes
 * `onRestart`, which owns the host-specific cleanup + process termination
 * (Ink unmount + exit 75 for the interactive CLI, Bun.spawn replacement +
 * exit 0 for headless, etc.).
 *
 * Only fires on `fatal` events whose error is a `RebootError`; other fatal
 * errors are ignored so callers can layer additional classifiers.  The loop
 * has already stopped processing by the time `onRestart` runs.
 */
export function wireRebootHandler(
  agent: AgentLoop,
  logPath: string,
  onRestart: (reason: string) => void | Promise<void>,
): void {
  agent.on("fatal", (event) => {
    if (!(event.error instanceof RebootError)) return;
    const reason = event.error.reason;
    void (async () => {
      await saveRebootSession(logPath, reason, () => agent.flush());
      debugLog("REBOOT", `Restarting: ${reason}`);
      await onRestart(reason);
    })();
  });
}
