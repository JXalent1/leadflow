/**
 * lib/cockpit.ts — the OPERATOR cockpit aggregate. (v2 Module V4)
 *
 * BY DESIGN this reads SUMMARY metrics across ALL clients: the operator owns every client and the
 * cockpit is the agency control room (leads-this-cycle vs. each client's lead guarantee, plus a
 * quick campaign-health read). This is the ONE place an aggregate spans clients, and it is
 * deliberately limited to per-client COUNTS — no contact-level data is exposed here. Nothing
 * client-FACING uses it; per-client drill-downs (the dashboard / inbox) stay strictly client-scoped
 * (V5 adds per-client logins). The cross-client aggregate is operator-only and never reaches a
 * client surface, so it is not an isolation violation (see sessions/v2-session-4-prompt.md).
 */

import "server-only";
import { sql } from "@/lib/db";
import { listClients } from "@/lib/clients";
import { currentCycle, expectedLeads, paceFlag, type Pace } from "@/lib/billing-cycle";
import { getTargetStatus } from "@/lib/auto-pause";
import { getCurrentInvoice, type InvoiceStatus } from "@/lib/billing";
import type { TargetPeriod } from "@/lib/lead-target";

export interface CockpitRow {
  clientId: number;
  name: string;
  status: string; // 'active' | 'paused'
  guarantee: number;
  /** Leads created within this client's current billing cycle. */
  leads: number;
  /** Straight-line expected leads at this point in the cycle (rounded), for the "behind by" read. */
  expected: number;
  pace: Pace;
  /** This cycle's campaign-health counts. */
  sent: number;
  inbound: number;
  optOuts: number;
  /** inbound / sent, as a percentage with one decimal (0 when nothing sent). */
  replyRatePct: number;
  /** opt-outs / sent, as a percentage with one decimal (0 when nothing sent). */
  optOutRatePct: number;
  cycleStart: string; // ISO
  cycleEnd: string; // ISO
  daysLeft: number;
  // --- V6: deliver-then-stop auto-pause status (per target period) ---
  target: number;
  targetPeriod: TargetPeriod;
  leadsThisPeriod: number;
  /** True when the lead target for the current period is met → the send path auto-pauses. */
  autoPaused: boolean;
  nextPeriod: string; // YYYY-MM-DD the period resets
  // --- V6: track-only billing ---
  planAmountCents: number;
  /** When the current billing cycle's invoice cuts (= cycle end). */
  nextBillDate: string; // ISO
  invoiceStatus: InvoiceStatus; // 'due' (implicit if not materialized) | 'invoiced' | 'paid'
  invoiceId: number | null; // null until materialized (first mark action)
}

export interface CockpitData {
  rows: CockpitRow[];
  generatedAt: string;
  totalClients: number;
  behindCount: number;
}

const PACE_RANK: Record<Pace, number> = { behind: 0, on_track: 1, met: 2 };

/** part/whole as a percentage rounded to one decimal; 0 when whole is 0. */
function ratePct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/**
 * Gather the cockpit's per-client cycle metrics. Operator-only; SUMMARY counts only. `now` is
 * injectable so the fixture can assert against a fixed cycle. One small query per client (the
 * operator's client count is tiny); each is client-scoped by client_id.
 */
export async function getCockpitData(now: Date = new Date()): Promise<CockpitData> {
  const clients = await listClients();

  const rows = await Promise.all(
    clients.map(async (c): Promise<CockpitRow> => {
      const cycle = currentCycle(now, c.billing_day);
      const start = cycle.start.toISOString();
      const end = cycle.end.toISOString();

      const counts = (
        await sql`
          SELECT
            (SELECT COUNT(*) FROM leads
               WHERE client_id = ${c.id}
                 AND created_at >= ${start} AND created_at < ${end})::int AS leads,
            (SELECT COUNT(*) FROM messages
               WHERE client_id = ${c.id} AND direction = 'outbound'
                 AND created_at >= ${start} AND created_at < ${end})::int AS sent,
            (SELECT COUNT(*) FROM messages
               WHERE client_id = ${c.id} AND direction = 'inbound'
                 AND created_at >= ${start} AND created_at < ${end})::int AS inbound,
            (SELECT COUNT(*) FROM opt_outs
               WHERE client_id = ${c.id}
                 AND created_at >= ${start} AND created_at < ${end})::int AS opt_outs
        `
      )[0] as { leads: number; sent: number; inbound: number; opt_outs: number };

      const pace = paceFlag(counts.leads, c.lead_guarantee, cycle.daysElapsed, cycle.cycleLengthDays);

      // V6: deliver-then-stop status + the current cycle's invoice (read-only — no materialize here).
      const [targetStatus, invoice] = await Promise.all([
        getTargetStatus(c, now),
        getCurrentInvoice(c, now),
      ]);

      return {
        clientId: c.id,
        name: c.name,
        status: c.status,
        guarantee: c.lead_guarantee,
        leads: counts.leads,
        expected: Math.round(
          expectedLeads(c.lead_guarantee, cycle.daysElapsed, cycle.cycleLengthDays)
        ),
        pace,
        sent: counts.sent,
        inbound: counts.inbound,
        optOuts: counts.opt_outs,
        replyRatePct: ratePct(counts.inbound, counts.sent),
        optOutRatePct: ratePct(counts.opt_outs, counts.sent),
        cycleStart: start,
        cycleEnd: end,
        daysLeft: cycle.daysLeft,
        target: targetStatus.target,
        targetPeriod: targetStatus.period,
        leadsThisPeriod: targetStatus.leadsThisPeriod,
        autoPaused: targetStatus.met,
        nextPeriod: targetStatus.nextPeriod,
        planAmountCents: c.plan_amount_cents,
        nextBillDate: end,
        invoiceStatus: invoice?.status ?? "due",
        invoiceId: invoice?.id ?? null,
      };
    })
  );

  // Behind first (most actionable), then on track, then met; within a group, lowest progress first.
  rows.sort((a, b) => {
    if (PACE_RANK[a.pace] !== PACE_RANK[b.pace]) return PACE_RANK[a.pace] - PACE_RANK[b.pace];
    const pa = a.guarantee > 0 ? a.leads / a.guarantee : 1;
    const pb = b.guarantee > 0 ? b.leads / b.guarantee : 1;
    if (pa !== pb) return pa - pb;
    return a.clientId - b.clientId;
  });

  return {
    rows,
    generatedAt: now.toISOString(),
    totalClients: rows.length,
    behindCount: rows.filter((r) => r.pace === "behind").length,
  };
}
