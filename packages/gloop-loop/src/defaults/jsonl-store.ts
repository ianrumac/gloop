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
import { type LogEvent, serializeEvent } from "../events.js";
import type { EventStore } from "../log.js";

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
  let dirReady: Promise<void> | null = null;

  const ensureDir = (): Promise<void> => {
    if (!dirReady) {
      dirReady = mkdir(dirname(path), { recursive: true }).then(() => undefined);
    }
    return dirReady;
  };

  return {
    path,
    async append(event) {
      if (!filter(event)) return;
      await ensureDir();
      await appendFile(path, JSON.stringify(serializeEvent(event)) + "\n", "utf-8");
    },
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf-8");
      } catch {
        return [];
      }
      const out: LogEvent[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as LogEvent;
          if (parsed && typeof parsed === "object" && typeof parsed.type === "string") out.push(parsed);
        } catch {
          // Partial trailing line from an interrupted write — skip.
        }
      }
      return out;
    },
  };
}
