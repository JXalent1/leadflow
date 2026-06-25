import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendBatchSize,
  clientPacingDelayMs,
  clampSendRate,
  MAX_SEND_RATE_PER_HOUR,
  TRACE_BATCH,
  SCRUB_BATCH,
} from "./pipeline";

// The driver's batch-size + pacing math. The load-bearing property: a send batch must stay well
// under the 300s function limit at ANY rate (server paces within the batch), and the realized
// rate must match the configured one (driver paces the gap between batches).

test("sendBatchSize clamps to at least 1 (even at a tiny rate)", () => {
  assert.equal(sendBatchSize(1), 1);
  assert.equal(sendBatchSize(20), 1);
  assert.equal(sendBatchSize(19), 1);
});

test("sendBatchSize scales ~rate/20 in the normal band", () => {
  assert.equal(sendBatchSize(60), 3);
  assert.equal(sendBatchSize(100), 5);
  assert.equal(sendBatchSize(600), 30);
});

test("sendBatchSize keeps scaling ~rate/20 up to the 250 cap (raised from 50)", () => {
  // 1000/hr is no longer the ceiling — it now scales to 50, not capped.
  assert.equal(sendBatchSize(1000), 50);
  assert.equal(sendBatchSize(2000), 100);
  // The cap first binds at rate 5000 (5000/20 = 250).
  assert.equal(sendBatchSize(5000), 250);
});

test("sendBatchSize caps at 250 for very high rates", () => {
  assert.equal(sendBatchSize(5000), 250);
  assert.equal(sendBatchSize(10_000), 250);
  assert.equal(sendBatchSize(MAX_SEND_RATE_PER_HOUR), 250);
});

test("a send batch stays bounded (≤250) and well under 300s at every sampled rate", () => {
  for (const rate of [1, 20, 60, 100, 250, 600, 1000, 5000, 10_000, 20_000]) {
    const size = sendBatchSize(rate);
    assert.ok(size <= 250, `rate ${rate}: batch size ${size} exceeds 250`);
    const delaySec = 3600 / rate; // server sleeps this between sends within the batch
    const batchSeconds = (size - 1) * delaySec; // no trailing sleep after the last send
    // Worst case is where the 250 cap first binds (rate 5000 → ~179s); always < 300s function limit.
    assert.ok(batchSeconds < 200, `rate ${rate}: batch would take ${batchSeconds}s`);
  }
});

test("realized rate ≈ target rate across the band (no off-by-orders-of-magnitude)", () => {
  // One batch cycle = (size-1) within-batch sleeps + one between-batch sleep ≈ size * (3600/rate) s,
  // so size sends per that window ⇒ realized ≈ target at every rate, including the new high band.
  for (const rate of [60, 600, 1000, 5000, 10_000, 20_000]) {
    const size = sendBatchSize(rate);
    const delaySec = 3600 / rate;
    const cycleSec = (size - 1) * delaySec + clientPacingDelayMs(rate) / 1000;
    const realizedPerHour = (size / cycleSec) * 3600;
    const relErr = Math.abs(realizedPerHour - rate) / rate;
    assert.ok(relErr < 0.05, `rate ${rate}: realized ${realizedPerHour.toFixed(0)}/hr (relErr ${relErr})`);
  }
});

test("clampSendRate accepts up to 20000 and floors to a positive integer", () => {
  assert.equal(clampSendRate(20_000), 20_000); // new ceiling accepted
  assert.equal(clampSendRate(10_000), 10_000);
  assert.equal(clampSendRate(25_000), 20_000); // above the ceiling → clamped down
  assert.equal(clampSendRate(1), 1);
  assert.equal(clampSendRate(0), 1); // ≤0 → floor of 1
  assert.equal(clampSendRate(-5), 1);
  assert.equal(clampSendRate(3.9), 3); // non-integer → floored
  assert.equal(clampSendRate(Number.NaN), 1); // non-finite → 1
  assert.equal(clampSendRate(Infinity), 1);
});

test("sendBatchSize falls back to the rate-60 batch for bad input", () => {
  assert.equal(sendBatchSize(0), 3);
  assert.equal(sendBatchSize(-5), 3);
  assert.equal(sendBatchSize(Number.NaN), 3);
});

test("clientPacingDelayMs matches the hourly rate", () => {
  assert.equal(clientPacingDelayMs(60), 60_000); // 1/min
  assert.equal(clientPacingDelayMs(3600), 1_000); // 1/sec
  assert.equal(clientPacingDelayMs(0), 60_000); // bad input → 60/hr default
});

test("trace/scrub batch sizes are sane positive constants", () => {
  assert.ok(TRACE_BATCH > 0 && SCRUB_BATCH > 0);
});
