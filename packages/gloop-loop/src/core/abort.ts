/**
 * Abort primitives shared by the interpreter and the retry helper.
 * Split out of `core.ts` so `retry.ts` can import them without pulling
 * the whole interpreter in (and without an import cycle).
 */

export class AbortError extends Error {
  constructor() { super("Interrupted by user"); this.name = "AbortError"; }
}

/** Race a promise against an AbortSignal. Rejects with AbortError if signal fires. */
export function raceAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AbortError());
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new AbortError()), { once: true })
    ),
  ]);
}
