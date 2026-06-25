/**
 * lib/auto-pause.ts — the deliver-then-stop gate STATUS. (v2 Module V6, SERVER-side.)
 *
 * `getTargetStatus` is the single source of truth the send route consults BEFORE sending: it counts
 * a client's leads in the current target period and decides whether the target has been met. When
 * met, the send route refuses to send (no wasted texts/credits past the goal) and resumes
 * automatically when the period rolls over or the operator raises the target.
 *
 * THIS IS A BUSINESS GATE LAYERED ON TOP OF SUPPRESSION/ELIGIBILITY — it never weakens them. A
 * target NOT met does not make any suppressed/opted-out contact eligible (that stays governed
 * entirely by getEligibleContacts/claimForSend); a target met only ADDS a stop. The pure period +
 * effective-target math lives in lib/lead-target.ts so it can be unit-tested without a DB; this
 * module only adds the lead count + the met decision.
 */

import "server-only";
import { countLeadsInPeriod } from "@/lib/db";
import type { Client } from "@/lib/clients";
import {
  currentTargetPeriod,
  effectiveLeadTarget,
  nextPeriodLabel,
  toTargetPeriod,
  type TargetPeriod,
} from "@/lib/lead-target";

export interface TargetStatus {
  /** Effective target for the period (explicit lead_target, else lead_guarantee). */
  target: number;
  period: TargetPeriod;
  /** Leads created in the current target period (counts toward the target). */
  leadsThisPeriod: number;
  /** True once the target is reached (>=). target <= 0 → never met (no auto-pause). */
  met: boolean;
  periodStart: string; // ISO, inclusive
  periodEnd: string; // ISO, exclusive — also when sending resumes
  /** YYYY-MM-DD of the next period's start, for the "paused until X" copy. */
  nextPeriod: string;
}

/**
 * Resolve the deliver-then-stop status for ONE client at `now` (injectable for the fixture). Reads
 * the client's effective target + current period window, counts this period's leads, and sets
 * `met`. Scoped to the one client_id via countLeadsInPeriod.
 */
export async function getTargetStatus(client: Client, now: Date = new Date()): Promise<TargetStatus> {
  const period = toTargetPeriod(client.target_period);
  const target = effectiveLeadTarget(client.lead_target, client.lead_guarantee);
  const { start, end } = currentTargetPeriod(now, period, client.billing_day);
  const periodStart = start.toISOString();
  const periodEnd = end.toISOString();

  const leadsThisPeriod = await countLeadsInPeriod(client.id, periodStart, periodEnd);
  // target <= 0 (unset/misconfigured) must NEVER auto-pause — that would strand sending.
  const met = target > 0 && leadsThisPeriod >= target;

  return {
    target,
    period,
    leadsThisPeriod,
    met,
    periodStart,
    periodEnd,
    nextPeriod: nextPeriodLabel(end),
  };
}
