/**
 * lib/retry.test.ts — unit tests for the transient-retry helper (withRetry/backoffDelay)
 * and the Tracerfy transient-error classifier. Runner: `tsx --test lib/*.test.ts`.
 * Pure (no DB, no network, deterministic via injected sleep + rng), so it runs under `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, backoffDelay, isTransientError } from "./retry";
import { TracerfyError } from "./tracerfy";

const noopSleep = async () => {};

// --- isTransientError -------------------------------------------------------

test("isTransientError: 429 / 408 / 5xx / no-status → transient", () => {
  assert.equal(isTransientError(new TracerfyError("rate", { status: 429 })), true);
  assert.equal(isTransientError(new TracerfyError("timeout", { status: 408 })), true);
  assert.equal(isTransientError(new TracerfyError("bad gw", { status: 502 })), true);
  assert.equal(isTransientError(new TracerfyError("oops", { status: 500 })), true);
  assert.equal(isTransientError(new TracerfyError("network")), true); // no status
});

test("isTransientError: other 4xx → terminal", () => {
  assert.equal(isTransientError(new TracerfyError("bad", { status: 400 })), false);
  assert.equal(isTransientError(new TracerfyError("auth", { status: 401 })), false);
  assert.equal(isTransientError(new TracerfyError("forbidden", { status: 403 })), false);
  assert.equal(isTransientError(new TracerfyError("missing", { status: 404 })), false);
});

test("isTransientError: a non-Tracerfy error is NOT retried (don't mask bugs/credits)", () => {
  assert.equal(isTransientError(new Error("boom")), false);
  assert.equal(isTransientError(new TypeError("x is undefined")), false);
});

// --- backoffDelay -----------------------------------------------------------

test("backoffDelay: grows exponentially, capped, bounded to [cap/2, cap]", () => {
  const base = 500;
  const maxDelayMs = 8000;
  // rng=0 → exactly cap/2; rng=1 → exactly cap.
  const low = (n: number) => backoffDelay(n, { baseDelayMs: base, maxDelayMs, rng: () => 0 });
  const high = (n: number) => backoffDelay(n, { baseDelayMs: base, maxDelayMs, rng: () => 1 });
  assert.equal(low(1), 250); // cap 500 → 250
  assert.equal(low(2), 500); // cap 1000 → 500
  assert.equal(low(3), 1000); // cap 2000 → 1000
  assert.equal(high(1), 500);
  assert.equal(high(2), 1000);
  // Cap binds: 500*2^5 = 16000 > 8000 → cap 8000.
  assert.equal(high(6), 8000);
  assert.equal(low(6), 4000);
});

test("backoffDelay: a mid-range rng stays within [cap/2, cap]", () => {
  const d = backoffDelay(3, { baseDelayMs: 500, maxDelayMs: 8000, rng: () => 0.5 });
  assert.ok(d >= 1000 && d <= 2000, `expected within [1000,2000], got ${d}`);
});

// --- withRetry --------------------------------------------------------------

test("withRetry: success on first try calls fn exactly once", async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    return "ok";
  }, { sleep: noopSleep });
  assert.equal(out, "ok");
  assert.equal(calls, 1);
});

test("withRetry: a transient error is retried then succeeds", async () => {
  let calls = 0;
  const retries: number[] = [];
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new TracerfyError("429", { status: 429 });
      return calls;
    },
    { sleep: noopSleep, rng: () => 0, onRetry: ({ attempt }) => retries.push(attempt) }
  );
  assert.equal(out, 3);
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]); // retried after attempts 1 and 2
});

test("withRetry: a terminal error is thrown immediately (no retry)", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new TracerfyError("bad input", { status: 400 });
        },
        { sleep: noopSleep }
      ),
    /bad input/
  );
  assert.equal(calls, 1);
});

test("withRetry: exhausts maxAttempts on a sustained transient error then throws", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new TracerfyError("sustained 429", { status: 429 });
        },
        { sleep: noopSleep, maxAttempts: 4 }
      ),
    /sustained 429/
  );
  assert.equal(calls, 4); // 1 initial + 3 retries
});

test("withRetry: a custom isRetryable overrides the default classifier", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error("retry me");
      return "done";
    },
    { sleep: noopSleep, isRetryable: () => true }
  );
  assert.equal(out, "done");
  assert.equal(calls, 2);
});
