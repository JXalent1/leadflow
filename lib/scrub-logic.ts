// lib/scrub-logic.ts — PURE scrub logic (no DB, no network), so it can be unit-tested and
// imported without triggering lib/db's module-load env check. lib/scrub re-exports these.
//
// Holds the fail-closed verdict (classify), the credit pre-flight threshold, the cost constant,
// and the typed insufficient-credits error. Keep the verdict logic UNCHANGED — clean/flagged
// decisions are correct; the 2026-06-23 bug was selection/re-billing, not classification.

import type { ScrubResultRow } from "@/lib/tracerfy";

export type ScrubReason = "litigator" | "dnc" | "scrub_error";

/** Tracerfy bills one credit per phone scrubbed (matches the live-run accounting). */
export const SCRUB_CREDITS_PER_PHONE = 1;

/** Thrown when the Tracerfy balance can't cover the batch — stop before spending. */
export class InsufficientCreditsError extends Error {
  constructor(
    public credits: number,
    public needed: number,
    public pending: number
  ) {
    super(`insufficient_credits: have ${credits}, need ${needed} for ${pending} pending`);
    this.name = "InsufficientCreditsError";
  }
}

/** Pure threshold check (unit-testable): can `credits` cover scrubbing `pendingCount` phones? */
export function creditsCoverScrub(credits: number, pendingCount: number): boolean {
  return credits >= pendingCount * SCRUB_CREDITS_PER_PHONE;
}

export function emptyReasons(): Record<ScrubReason, number> {
  return { litigator: 0, dnc: 0, scrub_error: 0 };
}

export function mergeReasons(parts: Record<ScrubReason, number>[]): Record<ScrubReason, number> {
  const out = emptyReasons();
  for (const p of parts) {
    out.litigator += p.litigator;
    out.dnc += p.dnc;
    out.scrub_error += p.scrub_error;
  }
  return out;
}

/** Decide suppression reason for a scrub row. null => verified clean, leave eligible. */
export function classify(row: ScrubResultRow | undefined): ScrubReason | null {
  // Missing result => fail closed.
  if (!row) return "scrub_error";
  if (row.litigator) return "litigator";
  if (row.federalDnc || row.stateDnc || row.dma) return "dnc";
  // Only an explicit clean verdict keeps a number eligible.
  if (row.isClean) return null;
  return "scrub_error";
}
