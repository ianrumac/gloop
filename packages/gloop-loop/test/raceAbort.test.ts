import { test, expect, describe } from "bun:test";
import { raceAbort, AbortError } from "../src/core/core.js";

describe("raceAbort", () => {
  test("resolves when no signal provided", async () => {
    const result = await raceAbort(undefined, Promise.resolve(42));
    expect(result).toBe(42);
  });

  test("resolves when signal is not aborted", async () => {
    const abort = new AbortController();
    const result = await raceAbort(abort.signal, Promise.resolve("hello"));
    expect(result).toBe("hello");
  });

  test("rejects immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(raceAbort(abort.signal, Promise.resolve("should not resolve"))).rejects.toThrow(AbortError);
  });

  test("rejects when signal fires during pending promise", async () => {
    const abort = new AbortController();

    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 1000);
    });

    // Abort after a tiny delay
    setTimeout(() => abort.abort(), 10);

    await expect(raceAbort(abort.signal, slow)).rejects.toThrow(AbortError);
  });

  test("resolves if promise settles before signal fires", async () => {
    const abort = new AbortController();

    const fast = Promise.resolve("fast");
    // Signal fires much later
    setTimeout(() => abort.abort(), 1000);

    const result = await raceAbort(abort.signal, fast);
    expect(result).toBe("fast");
  });

  test("propagates promise rejection (not AbortError)", async () => {
    const abort = new AbortController();
    const failing = Promise.reject(new Error("original error"));

    await expect(raceAbort(abort.signal, failing)).rejects.toThrow("original error");
  });

  test("propagates promise rejection without signal", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(raceAbort(undefined, failing)).rejects.toThrow("boom");
  });

  test("works with various promise value types", async () => {
    expect(await raceAbort(undefined, Promise.resolve(null))).toBeNull();
    expect(await raceAbort(undefined, Promise.resolve(0))).toBe(0);
    expect(await raceAbort(undefined, Promise.resolve(false))).toBe(false);
    expect(await raceAbort(undefined, Promise.resolve([1, 2]))).toEqual([1, 2]);
  });
});
