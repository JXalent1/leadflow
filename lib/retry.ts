// lib/retry.ts — generic retry-with-backoff for TRANSIENT external failures.
//
// Used by the skip-trace path (lib/skiptrace.ts) so a single rate-limit / timeout /
// 5xx from Tracerfy no longer kills a resumable run. Pure + dependency-light: the
// caller injects what counts as retryable (default: isTransientError below) plus,
// for tests, a fake sleep + rng so backoff is deterministic and instant.
//
// Charge-safety note: RETRY IS ONLY SAFE ON IDEMPOTENT CALLS. Reads (getCredits,
// poll/ingest) can be retried freely. The one charging call (submitTrace) is retried
// too because the dominant transient failure is a 429 (the request is REJECTED — no
// queue created, no credits spent — so a retry is safe). The only residual exposure is
// the narrow "submit succeeded server-side but the HTTP response was lost" window,
// which already orphaned an untracked paid queue before this change and is unchanged
// in cost terms by a bounded retry. See PR notes.

import { TracerfyError } from "@/lib/tracerfy";

export interface RetryOptions {
  /** Hard cap on total attempts (including the first). Default 4. */
  maxAttempts?: number;
  /** First backoff step in ms (doubles each retry, capped at maxDelayMs). Default 500. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff wait. Default 8000. */
  maxDelayMs?: number;
  /** Returns true if the error is worth retrying. Default: isTransientError. */
  isRetryable?: (err: unknown) => boolean;
  /** Observe each retry (logging) BEFORE the wait. */
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
  /** Injected for tests (default: real setTimeout sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests (default: Math.random). Used only for jitter. */
  rng?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Classify whether an error is a TRANSIENT Tracerfy failure (safe to retry):
 *  - no status (network / DNS / abort / timeout) → transient
 *  - 408 (request timeout) / 429 (rate limit)     → transient
 *  - any 5xx (upstream wobble)                     → transient
 *  - any other 4xx (bad input / auth / poison)     → terminal (do NOT retry)
 * A non-TracerfyError (e.g. a programming bug) is treated as terminal so retries
 * never mask a real defect, and so InsufficientCreditsError is never retried.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof TracerfyError) {
    const s = err.status;
    if (s === undefined) return true;
    if (s === 408 || s === 429) return true;
    if (s >= 500) return true;
    return false;
  }
  return false;
}

/**
 * Exponential backoff with "equal jitter": the wait for the Nth failed attempt is
 * `cap/2 + rand*cap/2` where `cap = min(maxDelayMs, baseDelayMs * 2^(attempt-1))`.
 * Bounded to [cap/2, cap], so it always grows yet never thunders. `attempt` is the
 * 1-based number of the attempt that just failed.
 */
export function backoffDelay(
  attempt: number,
  opts: { baseDelayMs?: number; maxDelayMs?: number; rng?: () => number } = {}
): number {
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const rng = opts.rng ?? Math.random;
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const half = cap / 2;
  return Math.round(half + rng() * half);
}

/**
 * Run `fn`, retrying transient failures with capped exponential backoff + jitter.
 * Re-throws the last error once attempts are exhausted or the error is non-retryable,
 * so terminal errors (credits, poison 4xx) surface immediately and unchanged.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const isRetryable = opts.isRetryable ?? isTransientError;
  const sleep = opts.sleep ?? realSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const delayMs = backoffDelay(attempt, opts);
      opts.onRetry?.({ attempt, delayMs, err });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
