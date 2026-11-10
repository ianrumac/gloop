/**
 * children.ts — Child processes tied to in-flight work.
 *
 * Bash commands and `--task` subagents register a kill callback while a tool
 * call is waiting on them, and unregister when it returns.  Shutdown
 * (src/core/shutdown.ts) kills whatever is still registered.  A command that
 * was deliberately moved to the background unregisters at that point, so it
 * survives gloop exiting.
 */

const live = new Set<() => void>();

/** Register a kill callback.  Returns the matching unregister function. */
export function trackChild(kill: () => void): () => void {
  live.add(kill);
  return () => {
    live.delete(kill);
  };
}

/** Number of tracked children (tests, debug logging). */
export function trackedChildCount(): number {
  return live.size;
}

/** Kill every tracked child and forget them.  Returns how many were killed. */
export function killTrackedChildren(): number {
  const kills = [...live];
  live.clear();
  for (const kill of kills) {
    try {
      kill();
    } catch {
      // Already gone — nothing to do.
    }
  }
  return kills.length;
}
