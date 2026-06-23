/**
 * lib/dashboard.ts — READ-ONLY aggregator for the Session 5 dashboard.
 *
 * One function (`getDashboardData`) gathers every read the dashboard needs so the
 * server component (initial render) and the polling `GET /api/dashboard` route share
 * exactly one shape. Nothing here mutates state — all writes go through the existing
 * /api/{skiptrace,scrub,campaign} endpoints. The inbound `disposition` is derived on
 * the fly from the pure classifier (no stored column, no side effect).
 */

import {
  getContactCounts,
  getSendProgress,
  getDashboardExtraCounts,
  getRecentLeads,
  getRecentInbound,
  getRecentOptOuts,
  hasActiveCampaignRun,
  type LeadRow,
  type InboundRow,
  type OptOutRow,
} from "@/lib/db";
import { isOptOut, classifyInterest } from "@/lib/classify";
import { withinSendWindow, sendWindowLabel, sendRatePerHour } from "@/lib/twilio";

export type InboundDisposition =
  | "opt_out"
  | "interested"
  | "not_interested"
  | "neutral";

export interface InboundFeedRow extends InboundRow {
  disposition: InboundDisposition;
}

export interface DashboardCounts {
  total: number;
  withPhone: number;
  suppressed: number;
  scrubbedClean: number;
  eligible: number;
  sent: number;
  pending: number;
  inFlight: number;
  failed: number;
  optedOut: number;
  leads: number;
}

export interface DashboardData {
  counts: DashboardCounts;
  sendWindow: { within: boolean; label: string };
  activeRun: boolean;
  ratePerHour: number;
  recentLeads: LeadRow[];
  recentInbound: InboundFeedRow[];
  recentOptOuts: OptOutRow[];
  /** Server timestamp (ISO) the snapshot was read — for a "last updated" line. */
  fetchedAt: string;
}

/** Derive a disposition label for an inbound reply (same precedence as the webhook). */
function dispositionFor(body: string): InboundDisposition {
  if (isOptOut(body)) return "opt_out";
  return classifyInterest(body);
}

/** Gather everything the dashboard renders. READ-ONLY. */
export async function getDashboardData(): Promise<DashboardData> {
  const [contactCounts, progress, extra, recentLeads, inbound, recentOptOuts, activeRun] =
    await Promise.all([
      getContactCounts(),
      getSendProgress(),
      getDashboardExtraCounts(),
      getRecentLeads(50),
      getRecentInbound(50),
      getRecentOptOuts(25),
      hasActiveCampaignRun(),
    ]);

  const recentInbound: InboundFeedRow[] = inbound.map((m) => ({
    ...m,
    disposition: dispositionFor(m.body),
  }));

  return {
    counts: {
      total: contactCounts.total,
      withPhone: contactCounts.withPhone,
      suppressed: progress.suppressed,
      scrubbedClean: extra.scrubbedClean,
      eligible: progress.eligible,
      sent: progress.sent,
      pending: progress.pending,
      inFlight: progress.in_flight,
      failed: progress.failed,
      optedOut: progress.opted_out,
      leads: extra.leads,
    },
    sendWindow: { within: withinSendWindow(), label: sendWindowLabel() },
    activeRun,
    ratePerHour: sendRatePerHour(),
    recentLeads,
    recentInbound,
    recentOptOuts,
    fetchedAt: new Date().toISOString(),
  };
}
