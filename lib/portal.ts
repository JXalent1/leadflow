/**
 * lib/portal.ts — the CLIENT-facing dashboard data, strictly single-client. (v2 Module V5)
 *
 * This is what a CLIENT user sees: their own leads + progress to their monthly guarantee. Every
 * query here is scoped to ONE client_id (the caller has already resolved it from the session via
 * resolveClientIdForUser, so a client can only ever pass their own). It returns ONLY client-safe
 * fields — their leads and a cycle progress summary. No pipeline counts, no other client, no
 * operator controls. (Contrast lib/cockpit.ts, which is the OPERATOR cross-client aggregate.)
 */

import "server-only";
import { sql } from "@/lib/db";
import type { Client } from "@/lib/clients";
import { clientBizName } from "@/lib/clients";
import { currentCycle, expectedLeads, paceFlag, type Pace } from "@/lib/billing-cycle";
import { getTargetStatus } from "@/lib/auto-pause";

export interface PortalLead {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  replyText: string | null;
  status: string;
  createdAt: string;
}

export interface PortalData {
  clientName: string;
  bizName: string;
  guarantee: number;
  leadsThisCycle: number;
  /** Straight-line expectation at this point in the cycle (rounded), for context. */
  expected: number;
  pace: Pace;
  daysLeft: number;
  cycleStart: string;
  cycleEnd: string;
  /** V6: true when this period's lead target is met → new outreach is paused until next period. */
  targetMet: boolean;
  /** YYYY-MM-DD the lead target resets (next period start). */
  targetResetsOn: string;
  recentLeads: PortalLead[];
  fetchedAt: string;
}

function leadName(first: string | null, last: string | null): string {
  const n = `${first ?? ""} ${last ?? ""}`.trim();
  return n || "New lead";
}

/** Most-recent leads for ONE client across ALL their campaigns, joined to the contact. Newest first. */
async function getClientRecentLeads(clientId: number, limit: number): Promise<PortalLead[]> {
  const rows = await sql`
    SELECT l.id, l.reply_text, l.status, l.created_at,
           c.first_name, c.last_name, c.address, c.phone
    FROM leads l
    JOIN contacts c ON c.id = l.contact_id AND c.client_id = l.client_id
    WHERE l.client_id = ${clientId}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit}
  `;
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    name: leadName(r.first_name as string | null, r.last_name as string | null),
    address: (r.address as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    replyText: (r.reply_text as string | null) ?? null,
    status: String(r.status),
    createdAt: String(r.created_at),
  }));
}

/**
 * Build the client portal snapshot for ONE client. READ-ONLY. `now` is injectable for the fixture.
 * leadsThisCycle counts the client's leads within their current billing cycle (same cycle math as
 * the operator cockpit), so the client sees the exact number that counts toward their guarantee.
 */
export async function getPortalData(client: Client, now: Date = new Date()): Promise<PortalData> {
  const clientId = client.id;
  const cycle = currentCycle(now, client.billing_day);
  const start = cycle.start.toISOString();
  const end = cycle.end.toISOString();

  const [countRow, recentLeads, targetStatus] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS n FROM leads
      WHERE client_id = ${clientId} AND created_at >= ${start} AND created_at < ${end}
    `,
    getClientRecentLeads(clientId, 50),
    getTargetStatus(client, now),
  ]);
  const leadsThisCycle = (countRow[0] as { n: number }).n;

  return {
    clientName: client.name,
    bizName: clientBizName(client),
    guarantee: client.lead_guarantee,
    leadsThisCycle,
    expected: Math.round(expectedLeads(client.lead_guarantee, cycle.daysElapsed, cycle.cycleLengthDays)),
    pace: paceFlag(leadsThisCycle, client.lead_guarantee, cycle.daysElapsed, cycle.cycleLengthDays),
    daysLeft: cycle.daysLeft,
    cycleStart: start,
    cycleEnd: end,
    targetMet: targetStatus.met,
    targetResetsOn: targetStatus.nextPeriod,
    recentLeads,
    fetchedAt: now.toISOString(),
  };
}
