/**
 * lib/login-throttle.ts — basic in-memory login throttling. (v2 Module V5)
 *
 * Slows down password guessing: after MAX_ATTEMPTS failures for a key (lowercased email) within
 * WINDOW_MS, further attempts are locked out until the window rolls off. A SUCCESS clears the key.
 *
 * LIMITATION (documented, acceptable for MVP per the spec): this is per-process memory, so on
 * serverless it's per-instance and best-effort — it blunts a naive single-instance brute force but
 * is not a distributed rate limiter. A durable limiter (DB/Upstash) is a later hardening step.
 * `now` is injectable so the unit test doesn't depend on the wall clock.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface Attempt {
  count: number;
  firstAt: number;
}

const attempts = new Map<string, Attempt>();

function normalize(key: string): string {
  return key.trim().toLowerCase();
}

/** True if this key is currently locked out (too many recent failures). */
export function isLockedOut(key: string, now: number = Date.now()): boolean {
  const a = attempts.get(normalize(key));
  if (!a) return false;
  if (now - a.firstAt > WINDOW_MS) {
    attempts.delete(normalize(key));
    return false;
  }
  return a.count >= MAX_ATTEMPTS;
}

/** Record a failed login for this key. Starts a fresh window if none is active. */
export function recordFailure(key: string, now: number = Date.now()): void {
  const k = normalize(key);
  const a = attempts.get(k);
  if (!a || now - a.firstAt > WINDOW_MS) {
    attempts.set(k, { count: 1, firstAt: now });
    return;
  }
  a.count += 1;
}

/** Clear the throttle for this key after a successful login. */
export function clearAttempts(key: string): void {
  attempts.delete(normalize(key));
}
