/**
 * lib/billing-cycle.ts — pure billing-cycle + pace math for the operator cockpit. (v2 Module V4)
 *
 * No DB, no I/O — testable in isolation. The cockpit counts leads (and campaign-health metrics)
 * within a client's CURRENT billing cycle and flags whether the client is behind the linear pace
 * it needs to hit its monthly lead guarantee.
 *
 * Cycle definition (decided 2026-06-24, see overview.md): a client's cycle runs from its
 * `billing_day` each month to the same day-of-month the next month, with boundaries taken at UTC
 * midnight. A null `billing_day` means the calendar month (equivalent to billing_day = 1). A
 * billing_day past a short month's last day is clamped to that last day (e.g. day 31 in February →
 * Feb 28/29), so every month has exactly one cycle boundary. UTC is used so the math is
 * deterministic regardless of server timezone (per-client send TZ is a separate concern).
 */

export type Pace = "behind" | "on_track" | "met";

export interface Cycle {
  /** Inclusive start (UTC midnight of the anchor day). */
  start: Date;
  /** Exclusive end (UTC midnight of next month's anchor day). */
  end: Date;
  /** Whole-day length of this cycle (28–31). */
  cycleLengthDays: number;
  /** Fractional days elapsed since start, clamped to [0, cycleLengthDays]. */
  daysElapsed: number;
  /** Whole days remaining until end (ceil), min 0. */
  daysLeft: number;
}

const DAY_MS = 86_400_000;

/** Last calendar day (28..31) of a given UTC year+month (month 0-indexed). */
function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Clamp a desired day-of-month into [1, last-day-of-that-month]. */
function clampDay(year: number, month: number, day: number): number {
  return Math.min(Math.max(1, day), lastDayOfMonth(year, month));
}

/** Normalize a raw billing_day (nullable) to an anchor in [1, 31]; null → 1 (calendar month). */
function anchorDay(billingDay: number | null): number {
  if (billingDay == null || !Number.isFinite(billingDay)) return 1;
  return Math.min(Math.max(1, Math.floor(billingDay)), 31);
}

/**
 * The billing cycle that CONTAINS `now`, for a client whose cycle anchors on `billingDay`
 * (1..31; null → 1 = calendar month). If `now` is before this month's anchor day, the cycle
 * started last month; otherwise it started this month.
 */
export function currentCycle(now: Date, billingDay: number | null): Cycle {
  const anchor = anchorDay(billingDay);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  let sY = y;
  let sM = m;
  if (d < clampDay(y, m, anchor)) {
    sM = m - 1;
    if (sM < 0) {
      sM = 11;
      sY = y - 1;
    }
  }
  const start = new Date(Date.UTC(sY, sM, clampDay(sY, sM, anchor)));

  let eY = sY;
  let eM = sM + 1;
  if (eM > 11) {
    eM = 0;
    eY = sY + 1;
  }
  const end = new Date(Date.UTC(eY, eM, clampDay(eY, eM, anchor)));

  const cycleLengthDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const elapsedRaw = (now.getTime() - start.getTime()) / DAY_MS;
  const daysElapsed = Math.min(Math.max(0, elapsedRaw), cycleLengthDays);
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));

  return { start, end, cycleLengthDays, daysElapsed, daysLeft };
}

/** Straight-line expected lead count at this point in the cycle if pacing to the guarantee. */
export function expectedLeads(
  guarantee: number,
  daysElapsed: number,
  cycleLengthDays: number
): number {
  if (cycleLengthDays <= 0) return 0;
  return guarantee * (daysElapsed / cycleLengthDays);
}

/**
 * Pace flag for the cockpit. `met` once the guarantee is reached; otherwise `behind` when the
 * actual lead count is under the straight-line expectation, else `on_track`. At day 0 the
 * expectation is 0, so a client with no leads yet reads `on_track` (not behind) until time elapses.
 */
export function paceFlag(
  leads: number,
  guarantee: number,
  daysElapsed: number,
  cycleLengthDays: number
): Pace {
  if (guarantee <= 0 || leads >= guarantee) return "met";
  return leads < expectedLeads(guarantee, daysElapsed, cycleLengthDays) ? "behind" : "on_track";
}
