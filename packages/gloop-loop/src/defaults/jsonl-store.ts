/**
 * JSONL-backed `EventStore` — one event per line, append-only.
 *
 *     import { AgentLoop, createJsonlEventStore } from "@hypen-space/gloop-loop";
 *
 *     const store = createJsonlEventStore(".gloop/sessions/today.jsonl");
 *     const agent = await AgentLoop.resume({ provider, model, store });
 *
 * `resume` loads the file, rebuilds the conversation, re-queues any turn
 * that was cut off, and keeps appending to the same file.
 *
 * Corrupt lines (a crash mid-write) are skipped on load.  Pass `filter` to
 * keep the file small — `isEphemeralEvent` is a good default exclusion:
 *
 *     createJsonlEventStore(path, { filter: (e) => !isEphemeralEvent(e) })
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEvent } from "../events.js";
import { parseJsonlEvents, type EventStore } from "../log.js";

export interface JsonlEventStoreOptions {
  /** Return `false` to skip persisting an event.  Default: persist all. */
  filter?: (event: LogEvent) => boolean;
}

export interface JsonlEventStore extends EventStore {
  readonly path: string;
}

export function createJsonlEventStore(
  path: string,
  options: JsonlEventStoreOptions = {},
): JsonlEventStore {
  const filter = options.filter ?? (() => true);
  let dirReady = false;

  const ensureDir = async (): Promise<void> => {
    if (dirReady) return;
    await mkdir(dirname(path), { recursive: true });
    dirReady = true;
  };

  return {
    path,
    async append(event) {
      if (!filter(event)) return;
      await ensureDir();
      await appendFile(path, JSON.stringify(event) + "\n", "utf-8");
    },
    async load() {
      try {
        return parseJsonlEvents(await readFile(path, "utf-8"));
      } catch (err) {
        // A missing file is an empty log; anything else (permissions, a
        // directory, I/O) must surface — silently starting fresh would
        // shadow the real session.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
  };
}
