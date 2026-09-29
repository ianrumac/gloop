/**
 * gloop-loop/retry — Small, dependency-free retry with exponential backoff.
 *
 * Used by the interpreter at the LLM boundary (opt-in via
 * `LoopConfig.retry.llm`) and the tool boundary (opt-in via
 * `LoopConfig.retry.tool`, and only for tools that declare
 * `retryable: true`).  Every retry is announced through `onRetry` so the
 * actor can log a `retry` event.
 */

import { AbortError, raceAbort } from "./core/abort.js";

export interface RetryPolicy {
  /** Total attempts, including the first.  `1` (or less) disables retry. */
  attempts: number;
  /** Delay before the second attempt, in ms.  Doubles each retry.  Default: 250. */
  backoffMs?: number;
  /** Cap on the delay between attempts.  Default: 10_000. */
  maxBackoffMs?: number;
  /**
   * Decide whether a failure is worth retrying.  Default: everything except
   * an `AbortError`.  Return `false` to surface the error immediately.
   */
  retryIf?: (error: unknown, attempt: number) => boolean;
}

export interface RetryConfig {
  /** Retry failed model calls. */
  llm?: RetryPolicy;
  /** Retry failed tool executions — only tools with `retryable: true`. */
  tool?: RetryPolicy;
}

export interface RetryAttemptInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
}

export interface WithRetryOptions {
  /** Called before each backoff sleep. */
  onRetry?: (info: RetryAttemptInfo) => void;
  /** Abort signal — an abort during backoff rejects with `AbortError`. */
  signal?: AbortSignal;
  /** Sleep implementation (tests inject a fake). */
  sleep?: (ms: number) => Promise<void>;
}

export function defaultRetryIf(error: unknown): boolean {
  return !(error instanceof AbortError);
}

export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const base = policy.backoffMs ?? 250;
  const cap = policy.maxBackoffMs ?? 10_000;
  return Math.min(cap, base * 2 ** (attempt - 1));
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` up to `policy.attempts` times.  `fn` receives the 1-based attempt
 * number.  The last error is rethrown when attempts are exhausted or
 * `retryIf` declines.
 */
export async function withRetry<T>(
  policy: RetryPolicy | undefined,
  fn: (attempt: number) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, policy?.attempts ?? 1);
  const retryIf = policy?.retryIf ?? defaultRetryIf;
  const sleep = options.sleep ?? realSleep;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !policy || !retryIf(err, attempt)) throw err;
      if (options.signal?.aborted) throw new AbortError();
      const delayMs = backoffDelay(policy, attempt);
      options.onRetry?.({ attempt, maxAttempts: attempts, delayMs, error: err });
      await raceAbort(options.signal, sleep(delayMs));
    }
  }
}
