import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendBatchSize,
  clientPacingDelayMs,
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

test("sendBatchSize caps at 50 for very high rates", () => {
  assert.equal(sendBatchSize(1000), 50);
  assert.equal(sendBatchSize(5000), 50);
});

test("a send batch's paced server time stays under 180s at every sampled rate", () => {
  for (const rate of [1, 20, 60, 100, 250, 600, 1000, 5000]) {
    const size = sendBatchSize(rate);
    const delaySec = 3600 / rate; // server sleeps this between sends within the batch
    const batchSeconds = (size - 1) * delaySec; // no trailing sleep after the last send
    assert.ok(batchSeconds < 180, `rate ${rate}: batch would take ${batchSeconds}s`);
  }
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
