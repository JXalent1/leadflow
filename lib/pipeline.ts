/**
 * lib/pipeline.ts — PURE helpers for the client-side guided pipeline driver. (v2 Module V3)
 *
 * The driver (components/pipeline-runner.tsx) re-invokes the existing batch endpoints
 * (/api/skiptrace, /api/scrub, /api/campaign) one batch at a time and loops until each stage is
 * drained, so no single request hits the function timeout and the operator clicks Run only once.
 *
 * This module is dependency-free (no Twilio/DB/Neon imports) so it is safe to bundle into the
 * client component AND unit-testable without a DB. It only does the batch-size + pacing math and
 * holds the shared constants; all fetching/looping lives in the component.
 */

/** Trace/scrub batch sizes — each batch submits one Tracerfy queue and polls it, well within 300s. */
export const TRACE_BATCH = 200;
export const SCRUB_BATCH = 200;

/**
 * Safety cap on stage loop iterations (defense against a never-draining stage). The largest list
 * the uploader accepts is 50k rows; at the smallest send batch (1/iteration) that is 50k batches,
 * so this is generous headroom — hitting it means a stage isn't converging and the driver halts.
 */
export const MAX_STAGE_ITERATIONS = 60_000;

/**
 * The maximum settable send rate (sends/hour). Raised 1000 → 20000 (2026-06-25) so an experienced,
 * A2P-compliant Twilio sender can drive the pipeline at their real 10DLC throughput; the 1000 cap
 * was an early-build artifact. The pacing below scales with the rate so high values materialize
 * without a batch ever approaching the 300s function limit. Safety (no-double-send, send window,
 * opt-out/suppression) is independent of the rate and unchanged.
 */
export const MAX_SEND_RATE_PER_HOUR = 20_000;

/**
 * Clamp a requested send rate to [1, MAX_SEND_RATE_PER_HOUR], integer-coerced. PURE (dependency-free)
 * so it's the single source of truth shared by the API setter (setClientSendRate) and the UI input
 * max, and is unit-testable without a DB. Non-finite input floors to 1 (the API layer already
 * rejects non-number / <1 before this is reached).
 */
export function clampSendRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.max(1, Math.min(MAX_SEND_RATE_PER_HOUR, Math.floor(rate)));
}

/**
 * How many contacts to send in ONE driven batch, given the live rate (sends/hour).
 *
 * The send endpoint paces WITHIN a batch (sleeping 3600/rate s between sends), so a batch's server
 * time is about (size - 1) * (3600 / rate) seconds. We size the batch as size ≈ rate / 20, clamped
 * to [1, 250]. Because the within-batch delay shrinks as the rate grows, the worst-case batch time
 * occurs where the cap first binds (rate = 5000 → size 250 → ~249 * 0.72s ≈ 179s), and it only gets
 * FASTER above that (e.g. 10000/hr → ~90s, 20000/hr → ~45s) — so a batch always finishes safely
 * inside the 300s function limit while keeping the per-batch count bounded (≤250). The driver then
 * sleeps one pacing delay BETWEEN batches (clientPacingDelayMs) so the boundary gap isn't skipped and
 * the realized rate matches the configured one. (Cap raised 50 → 250 on 2026-06-25 so rates above
 * ~1000/hr are actually reachable instead of being throttled by the old 50-send cap.)
 */
export function sendBatchSize(ratePerHour: number): number {
  const r = Number.isFinite(ratePerHour) && ratePerHour > 0 ? ratePerHour : 60;
  return Math.max(1, Math.min(250, Math.floor(r / 20)));
}

/**
 * Milliseconds to wait BETWEEN driven send batches to honor the hourly rate. Mirrors
 * lib/twilio.pacingDelayMs (kept here dependency-free for the client bundle). With the server
 * pacing inside a batch and the driver pacing this gap between batches, the realized send rate
 * matches client.send_rate_per_hour.
 */
export function clientPacingDelayMs(ratePerHour: number): number {
  const r = Number.isFinite(ratePerHour) && ratePerHour > 0 ? Math.max(1, Math.floor(ratePerHour)) : 60;
  return Math.round(3_600_000 / r);
}
