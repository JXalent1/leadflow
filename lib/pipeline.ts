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
 * How many contacts to send in ONE driven batch, given the live rate (sends/hour).
 *
 * The send endpoint paces WITHIN a batch (sleeping between sends), so a batch's server time is
 * about (size - 1) * (3600 / rate) seconds. We size the batch so that stays under ~180s — safely
 * inside the 300s function limit — at any rate: size ≈ rate / 20, clamped to [1, 50]. The driver
 * then sleeps one pacing delay BETWEEN batches (clientPacingDelayMs) so the boundary gap isn't
 * skipped and the realized rate matches the configured one.
 */
export function sendBatchSize(ratePerHour: number): number {
  const r = Number.isFinite(ratePerHour) && ratePerHour > 0 ? ratePerHour : 60;
  return Math.max(1, Math.min(50, Math.floor(r / 20)));
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
