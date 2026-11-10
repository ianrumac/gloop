/**
 * shutdown.ts — Stop gloop cleanly on Ctrl+C / SIGINT / SIGTERM / SIGHUP.
 *
 * One sequence for every mode: tear down the UI, stop the agent (interrupts
 * the turn, so a running Bash command or subagent is killed through its
 * abort signal, and flushes the session log), kill any child still tied to
 * an in-flight tool call, run the host's last words, exit.
 *
 * A second request while that runs exits at once.  The same signal arriving
 * twice within `dedupeMs` counts once: the launcher forwards signals to its
 * child, and a terminal delivers them to the whole process group too.
 */

import { killTrackedChildren } from "./children.ts";

export type ShutdownReason = "SIGINT" | "SIGTERM" | "SIGHUP" | "quit";

/** 128 + signal number; a user quit (Ctrl+C in the TUI) is a normal exit. */
export const EXIT_CODES: Record<ShutdownReason, number> = {
  quit: 0,
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export interface ShutdownDeps {
  /** Interrupt the turn, stop the loop, flush the log (`agent.stop()`). */
  stopAgent: () => Promise<void>;
  /** Tear down the UI first (Ink unmount, raw mode off). */
  beforeStop?: () => void;
  /** After the agent stopped and children are dead — e.g. a final JSONL event. */
  afterStop?: (reason: ShutdownReason, code: number) => void | Promise<void>;
  /** Default: `killTrackedChildren`. */
  killChildren?: () => number;
  /** Default: `process.exit`. */
  exit?: (code: number) => void;
  /** Give up waiting on `stopAgent` after this long.  Default 5s. */
  stopTimeoutMs?: number;
  /** Repeats of the same signal within this window are one request.  Default 300ms. */
  dedupeMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

export interface Shutdown {
  /** Start the sequence (or, if it is already running, exit now). */
  request(reason: ShutdownReason): Promise<void>;
  readonly inProgress: boolean;
}

export function createShutdown(deps: ShutdownDeps): Shutdown {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const now = deps.now ?? Date.now;
  const dedupeMs = deps.dedupeMs ?? 300;
  let first: { reason: ShutdownReason; at: number } | null = null;

  async function request(reason: ShutdownReason): Promise<void> {
    const code = EXIT_CODES[reason];
    if (first) {
      if (reason === first.reason && now() - first.at < dedupeMs) return;
      deps.log?.(`second ${reason} during shutdown — exiting now`);
      (deps.killChildren ?? killTrackedChildren)();
      exit(code);
      return;
    }
    first = { reason, at: now() };
    deps.log?.(`shutdown: ${reason}`);

    try {
      deps.beforeStop?.();
    } catch {
      // A UI that is already gone is fine.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        deps.stopAgent(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            deps.log?.("agent did not stop in time");
            resolve();
          }, deps.stopTimeoutMs ?? 5000);
        }),
      ]);
    } catch (err) {
      deps.log?.(`agent.stop failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const killed = (deps.killChildren ?? killTrackedChildren)();
    if (killed > 0) deps.log?.(`killed ${killed} child process(es)`);
    try {
      await deps.afterStop?.(reason, code);
    } catch {
      // Best effort.
    }
    exit(code);
  }

  return {
    request,
    get inProgress() {
      return first !== null;
    },
  };
}

/** Route SIGINT / SIGTERM / SIGHUP to `shutdown.request`.  Returns an uninstaller. */
export function installSignalHandlers(shutdown: Shutdown): () => void {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((sig) => {
    const handler = () => void shutdown.request(sig);
    process.on(sig, handler);
    return [sig, handler] as const;
  });
  return () => {
    for (const [sig, handler] of handlers) process.off(sig, handler);
  };
}
