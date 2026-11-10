/**
 * context-window.ts — how many tokens the model's context holds.
 *
 * Resolution order:
 *   1. an explicit `contextWindow` setting (`--context-window` / config file);
 *   2. the models list: `GET https://openrouter.ai/api/v1/models` (public), or
 *      `${OPENROUTER_BASE_URL}/models` when a base URL is set — cached per
 *      model in `.gloop/models-cache.json` for a day, so a normal startup
 *      does not touch the network;
 *   3. `DEFAULT_CONTEXT_WINDOW` (128k).
 *
 * Never throws: a network error, a timeout, a bad response or an unwritable
 * cache only means falling through to the next step (with a `notes` line
 * for the debug log).
 */

import { mkdir } from "fs/promises";
import { dirname, join } from "path";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const MODELS_CACHE_FILE = join(".gloop", "models-cache.json");
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ContextWindowOptions {
  model: string;
  /** The `contextWindow` setting, when set — wins outright. */
  explicit?: number;
  /** `OPENROUTER_BASE_URL`; the models list is fetched from `${baseUrl}/models`. */
  baseUrl?: string;
  /** Sent as a bearer token (a custom endpoint may want it; OpenRouter's list is public). */
  apiKey?: string;
  /** Cache file.  Default `<cwd>/.gloop/models-cache.json`. */
  cacheFile?: string;
  cwd?: string;
  /** Injected for tests.  Default: global `fetch`. */
  fetch?: FetchLike;
  /** Default 2000 ms. */
  timeoutMs?: number;
  /** How long a cached entry is trusted.  Default one day. */
  ttlMs?: number;
  now?: () => number;
}

export interface ContextWindow {
  tokens: number;
  source: "explicit" | "cache" | "fetched" | "default";
  /** Debug-log lines: where the figure came from, what failed. */
  notes: string[];
}

interface CacheEntry {
  /** null = the list was fetched and the model was not in it. */
  contextLength: number | null;
  fetchedAt: number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

/** The models-list URL for a base URL (none = OpenRouter). */
export function modelsUrl(baseUrl?: string): string {
  if (!baseUrl) return OPENROUTER_MODELS_URL;
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/** `vendor/model:free` → `vendor/model`. */
function stripVariant(id: string): string {
  const colon = id.lastIndexOf(":");
  return colon > id.lastIndexOf("/") ? id.slice(0, colon) : id;
}

function contextLengthOf(entry: Record<string, unknown>): number | null {
  for (const key of ["context_length", "context_window", "max_context_length"]) {
    const v = entry[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  const top = entry.top_provider as Record<string, unknown> | undefined;
  if (top && typeof top.context_length === "number" && top.context_length > 0) return Math.floor(top.context_length);
  return null;
}

/**
 * Find `model` in a models-list response (`{ data: [...] }` or a bare
 * array).  Exact id first, then ignoring an OpenRouter `:variant` suffix on
 * either side (`:free`, `:nitro`, …), case-insensitively.  Null when the
 * model is not listed or has no context figure.
 */
export function findContextLength(body: unknown, model: string): number | null {
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return null;
  const entries = list.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string");
  const want = model.toLowerCase();
  const wantBase = stripVariant(want);
  const idOf = (e: Record<string, unknown>) => (e.id as string).toLowerCase();
  const slugOf = (e: Record<string, unknown>) => (typeof e.canonical_slug === "string" ? e.canonical_slug.toLowerCase() : "");
  const passes: Array<(e: Record<string, unknown>) => boolean> = [
    (e) => idOf(e) === want,
    (e) => idOf(e) === wantBase,
    (e) => stripVariant(idOf(e)) === wantBase,
    (e) => slugOf(e) === want || slugOf(e) === wantBase,
  ];
  for (const pass of passes) {
    for (const e of entries) {
      if (!pass(e)) continue;
      const n = contextLengthOf(e);
      if (n !== null) return n;
    }
  }
  return null;
}

async function readCache(path: string): Promise<CacheFile> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return { version: 1, entries: {} };
    const parsed = JSON.parse(await file.text()) as Partial<CacheFile>;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") return parsed as CacheFile;
  } catch {
    // Corrupt cache — start over.
  }
  return { version: 1, entries: {} };
}

async function writeCache(path: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(cache, null, 2) + "\n");
}

/** Resolve the context window for `opts.model`.  Never throws. */
export async function resolveContextWindow(opts: ContextWindowOptions): Promise<ContextWindow> {
  const notes: string[] = [];
  if (opts.explicit !== undefined && opts.explicit > 0) {
    return { tokens: opts.explicit, source: "explicit", notes: [`context window ${opts.explicit} (contextWindow setting)`] };
  }

  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const url = modelsUrl(opts.baseUrl);
  const key = `${url} ${opts.model}`;
  const cachePath = opts.cacheFile ?? join(opts.cwd ?? process.cwd(), MODELS_CACHE_FILE);
  const fallback = (why: string): ContextWindow => {
    notes.push(`context window unknown for ${opts.model} (${why}); assuming ${DEFAULT_CONTEXT_WINDOW}`);
    return { tokens: DEFAULT_CONTEXT_WINDOW, source: "default", notes };
  };

  const cache = await readCache(cachePath);
  const hit = cache.entries[key];
  if (hit && now() - hit.fetchedAt < ttl) {
    if (hit.contextLength !== null) {
      notes.push(`context window ${hit.contextLength} for ${opts.model} (cached from ${url})`);
      return { tokens: hit.contextLength, source: "cache", notes };
    }
    return fallback(`not listed at ${url}, cached`);
  }

  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  let body: unknown;
  try {
    const res = await doFetch(url, {
      headers: {
        accept: "application/json",
        ...(opts.apiKey && { authorization: `Bearer ${opts.apiKey}` }),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return fallback(`${url} answered HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    return fallback(`fetching ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const found = findContextLength(body, opts.model);
  cache.entries[key] = { contextLength: found, fetchedAt: now() };
  try {
    await writeCache(cachePath, cache);
  } catch (err) {
    notes.push(`could not write ${cachePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (found === null) return fallback(`not listed at ${url}`);
  notes.push(`context window ${found} for ${opts.model} (from ${url})`);
  return { tokens: found, source: "fetched", notes };
}
