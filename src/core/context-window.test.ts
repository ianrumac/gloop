import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_CONTEXT_WINDOW,
  OPENROUTER_MODELS_URL,
  findContextLength,
  modelsUrl,
  resolveContextWindow,
  type FetchLike,
} from "./context-window.ts";

const MODELS = {
  data: [
    { id: "anthropic/claude-opus-4.6", context_length: 1_000_000 },
    { id: "z-ai/glm-4.6", context_length: 204_800 },
    { id: "meta/llama-x:free", context_length: 32_000 },
    { id: "meta/llama-x", context_length: 131_072 },
    { id: "other/windowed", context_window: 64_000 },
    { id: "other/maxctx", max_context_length: 48_000 },
    { id: "other/none" },
  ],
};

/** A fetch double that records calls and answers with `body` (or throws / an HTTP status). */
function fakeFetch(answer: { body?: unknown; status?: number; error?: Error } = { body: MODELS }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (answer.error) throw answer.error;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  };
  return { fn, calls };
}

const tmpCache = () => join(mkdtempSync(join(tmpdir(), "gloop-cw-")), ".gloop", "models-cache.json");

describe("findContextLength", () => {
  test("exact id, :variant suffix on either side, alternative field names", () => {
    expect(findContextLength(MODELS, "anthropic/claude-opus-4.6")).toBe(1_000_000);
    expect(findContextLength(MODELS, "Z-AI/GLM-4.6")).toBe(204_800);
    // The listed variant wins when it exists; otherwise the base model.
    expect(findContextLength(MODELS, "meta/llama-x:free")).toBe(32_000);
    expect(findContextLength(MODELS, "meta/llama-x:nitro")).toBe(131_072);
    expect(findContextLength(MODELS, "z-ai/glm-4.6:nitro")).toBe(204_800);
    expect(findContextLength({ data: [{ id: "v/m:free", context_length: 8_000 }] }, "v/m")).toBe(8_000);
    expect(findContextLength(MODELS, "other/windowed")).toBe(64_000);
    expect(findContextLength(MODELS, "other/maxctx")).toBe(48_000);
    expect(findContextLength(MODELS.data, "z-ai/glm-4.6")).toBe(204_800);
  });

  test("unknown model, no figure, junk → null", () => {
    expect(findContextLength(MODELS, "nope/nope")).toBeNull();
    expect(findContextLength(MODELS, "other/none")).toBeNull();
    expect(findContextLength({ error: "x" }, "a")).toBeNull();
    expect(findContextLength(null, "a")).toBeNull();
  });
});

describe("modelsUrl", () => {
  test("OpenRouter by default; ${base}/models otherwise", () => {
    expect(modelsUrl()).toBe(OPENROUTER_MODELS_URL);
    expect(modelsUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1/models");
  });
});

describe("resolveContextWindow", () => {
  test("an explicit setting wins without touching the network", async () => {
    const f = fakeFetch();
    const r = await resolveContextWindow({ model: "z-ai/glm-4.6", explicit: 50_000, fetch: f.fn, cacheFile: tmpCache() });
    expect(r).toMatchObject({ tokens: 50_000, source: "explicit" });
    expect(f.calls).toHaveLength(0);
  });

  test("fetches once, then serves from the cache until the TTL passes", async () => {
    const cacheFile = tmpCache();
    let now = 1_000_000;
    const f = fakeFetch();
    const opts = { model: "z-ai/glm-4.6", fetch: f.fn, cacheFile, now: () => now };

    expect(await resolveContextWindow(opts)).toMatchObject({ tokens: 204_800, source: "fetched" });
    expect(f.calls.map((c) => c.url)).toEqual([OPENROUTER_MODELS_URL]);
    // No key is sent to the public OpenRouter list unless asked.
    expect(new Headers(f.calls[0]!.init?.headers).get("authorization")).toBeNull();
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(cached.entries[`${OPENROUTER_MODELS_URL} z-ai/glm-4.6`]).toEqual({ contextLength: 204_800, fetchedAt: 1_000_000 });

    now += 60_000;
    expect(await resolveContextWindow(opts)).toMatchObject({ tokens: 204_800, source: "cache" });
    expect(f.calls).toHaveLength(1);

    now += 25 * 60 * 60 * 1000;
    expect(await resolveContextWindow(opts)).toMatchObject({ tokens: 204_800, source: "fetched" });
    expect(f.calls).toHaveLength(2);
  });

  test("a model the list does not have falls back to 128k, and the miss is cached", async () => {
    const cacheFile = tmpCache();
    const f = fakeFetch();
    const r = await resolveContextWindow({ model: "nope/nope", fetch: f.fn, cacheFile });
    expect(r.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(r.source).toBe("default");
    expect(r.notes.join("\n")).toContain("assuming 128000");
    await resolveContextWindow({ model: "nope/nope", fetch: f.fn, cacheFile });
    expect(f.calls).toHaveLength(1);
  });

  test("network errors, HTTP errors and junk never throw and are not cached", async () => {
    for (const answer of [{ error: new Error("ECONNREFUSED") }, { status: 503 }, { body: "<html>" }]) {
      const cacheFile = tmpCache();
      const f = fakeFetch(answer);
      const r = await resolveContextWindow({ model: "z-ai/glm-4.6", fetch: f.fn, cacheFile });
      expect(r.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(r.source).toBe("default");
      await resolveContextWindow({ model: "z-ai/glm-4.6", fetch: f.fn, cacheFile });
      // HTTP / network failures are retried next time; a parsed body without the model is cached.
      expect(f.calls.length).toBe("body" in answer ? 1 : 2);
    }
  });

  test("a slow endpoint is abandoned after the timeout", async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
      });
    const started = Date.now();
    const r = await resolveContextWindow({ model: "a/b", fetch: slow, cacheFile: tmpCache(), timeoutMs: 50 });
    expect(r.source).toBe("default");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a base URL is used for the list, with the key", async () => {
    const f = fakeFetch({ body: { data: [{ id: "local-model", context_window: 32_768 }] } });
    const r = await resolveContextWindow({
      model: "local-model",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk-test",
      fetch: f.fn,
      cacheFile: tmpCache(),
    });
    expect(r).toMatchObject({ tokens: 32_768, source: "fetched" });
    expect(f.calls[0]!.url).toBe("http://localhost:1234/v1/models");
    expect(new Headers(f.calls[0]!.init?.headers).get("authorization")).toBe("Bearer sk-test");
  });

  test("a corrupt cache file is ignored", async () => {
    const cacheFile = tmpCache();
    await Bun.write(cacheFile, "{ nope");
    const f = fakeFetch();
    expect(await resolveContextWindow({ model: "z-ai/glm-4.6", fetch: f.fn, cacheFile })).toMatchObject({ tokens: 204_800 });
    writeFileSync(cacheFile, JSON.stringify({ version: 1, entries: { [`${OPENROUTER_MODELS_URL} z-ai/glm-4.6`]: { contextLength: 7, fetchedAt: Date.now() } } }));
    expect(await resolveContextWindow({ model: "z-ai/glm-4.6", fetch: f.fn, cacheFile })).toMatchObject({ tokens: 7, source: "cache" });
  });
});
