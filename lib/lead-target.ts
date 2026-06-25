/**
 * lib/lead-target.ts — pure lead-target + target-period math for the V6 deliver-then-stop gate.
 *
 * No DB, no I/O — testable in isolation (see lead-target.test.ts). It answers two pure questions:
 *   1. What is the client's EFFECTIVE lead target? (explicit lead_target, else lead_guarantee.)
 *   2. What is the CURRENT target period window containing `now`?
 *
 * Target period (decided 2026-06-25, see overview.md):
 *   - 'month' → the client's BILLING cycle (reuses lib/billing-cycle.ts, so the auto-pause period
 *     lines up exactly with the cockpit/portal monthly guarantee window).
 *   - 'week'  → the ISO week containing `now`: Monday 00:00 UTC up to the following Monday 00:00 UTC
 *     (exclusive). UTC so the boundary is deterministic regardless of server timezone, matching the
 *     billing-cycle convention. Shifting `now` by 7 days shifts the window by exactly 7 days, so a
 *     lead falls in exactly one week — the period rolls over cleanly.
 *
 * The DB-backed status (counting leads in the window, computing `met`) lives in lib/auto-pause.ts;
 * this module stays pure so the boundary math can be unit-tested without a database.
 */

import { currentCycle } from "@/lib/billing-cycle";

export type TargetPeriod = "week" | "month";

export interface TargetWindow {
  /** Inclusive start (UTC midnight). */
  start: Date;
  /** Exclusive end (UTC midnight). */
  end: Date;
  period: TargetPeriod;
}

const DAY_MS = 86_400_000;

/** Coerce a raw target_period value to a known period; anything but 'week' → 'month'. */
export function toTargetPeriod(raw: string | null | undefined): TargetPeriod {
  return raw === "week" ? "week" : "month";
}

/**
 * The client's effective lead target. A null/non-finite lead_target falls back to the contractual
 * lead_guarantee (so a client whose target equals its guarantee needs no extra config). Floored and
 * clamped to >= 0; the caller treats target <= 0 as "no auto-pause" (never strands sending).
 */
export function effectiveLeadTarget(
  leadTarget: number | null | undefined,
  leadGuarantee: number
): number {
  if (leadTarget == null || !Number.isFinite(leadTarget)) return Math.max(0, Math.floor(leadGuarantee));
  return Math.max(0, Math.floor(leadTarget));
}

/** Monday 00:00 UTC of the ISO week containing `now`. */
function isoWeekStart(now: Date): Date {
  const dow = now.getUTCDay(); // 0=Sun .. 6=Sat
  const sinceMonday = (dow + 6) % 7; // days since Monday
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday));
}

/**
 * The current target period window containing `now`. 'month' delegates to the billing cycle (so the
 * auto-pause month lines up with the guarantee cycle); 'week' is the Mon–Mon UTC ISO week.
 */
export function currentTargetPeriod(
  now: Date,
  period: TargetPeriod,
  billingDay: number | null
): TargetWindow {
  if (period === "week") {
    const start = isoWeekStart(now);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    return { start, end, period };
  }
  const cycle = currentCycle(now, billingDay);
  return { start: cycle.start, end: cycle.end, period: "month" };
}

/** Short UTC date label (YYYY-MM-DD) for the next period's start — used in the "paused until X" copy. */
export function nextPeriodLabel(periodEnd: Date): string {
  return periodEnd.toISOString().slice(0, 10);
}
