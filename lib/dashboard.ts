/**
 * lib/dashboard.ts — READ-ONLY aggregator for the Session 5 dashboard.
 *
 * One function (`getDashboardData`) gathers every read the dashboard needs so the
 * server component (initial render) and the polling `GET /api/dashboard` route share
 * exactly one shape. Nothing here mutates state — all writes go through the existing
 * /api/{skiptrace,scrub,campaign} endpoints. The inbound `disposition` is derived on
 * the fly from the pure classifier (no stored column, no side effect).
 */

import { getContactCounts, getSendProgress } from "@/lib/db";
import { getActiveCampaignRun } from "@/lib/campaign-runs";
import { getTargetStatus } from "@/lib/auto-pause";
import type { TargetPeriod } from "@/lib/lead-target";
import {
  getDashboardExtraCounts,
  getRecentLeads,
  getRecentInbound,
  getRecentOptOuts,
  type LeadRow,
  type InboundRow,
  type OptOutRow,
} from "@/lib/dashboard-db";
import { clientWindow, type Client } from "@/lib/clients";
import { listCampaigns, type Campaign, type CampaignSummary } from "@/lib/campaigns";
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
  clientId: number;
  clientName: string;
  /** The campaign this snapshot is scoped to. */
  campaignId: number;
  campaignName: string;
  /** All of this client's campaigns, for the selector. */
  campaigns: CampaignSummary[];
  counts: DashboardCounts;
  sendWindow: { within: boolean; label: string };
  activeRun: boolean;
  /** The in-flight run's id, so the client-side driver can RESUME/continue its OWN run. */
  activeRunId: number | null;
  ratePerHour: number;
  /** V6 deliver-then-stop status for this client's current target period. */
  autoPause: {
    target: number;
    period: TargetPeriod;
    leadsThisPeriod: number;
    met: boolean;
    nextPeriod: string;
  };
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

/**
 * Gather everything the dashboard renders for ONE client, scoped to ONE campaign. READ-ONLY.
 * Counts + leads/reply feeds are campaign-scoped; the opt-out list stays CLIENT-level because
 * suppression is client-level (an opt-out applies across all of the client's campaigns).
 */
export async function getDashboardData(client: Client, campaign: Campaign): Promise<DashboardData> {
  const clientId = client.id;
  const campaignId = campaign.id;
  const window = clientWindow(client);
  const [contactCounts, progress, extra, recentLeads, inbound, recentOptOuts, activeRun, campaigns, targetStatus] =
    await Promise.all([
      getContactCounts(clientId, campaignId),
      getSendProgress(clientId, campaignId, campaign.source_campaign_id !== null),
      getDashboardExtraCounts(clientId, campaignId),
      getRecentLeads(clientId, campaignId, 50),
      getRecentInbound(clientId, campaignId, 50),
      getRecentOptOuts(clientId, 25),
      getActiveCampaignRun(clientId, campaignId),
      listCampaigns(clientId),
      getTargetStatus(client),
    ]);

  const recentInbound: InboundFeedRow[] = inbound.map((m) => ({
    ...m,
    disposition: dispositionFor(m.body),
  }));

  return {
    clientId,
    clientName: client.name,
    campaignId,
    campaignName: campaign.name,
    campaigns,
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
    sendWindow: { within: withinSendWindow(new Date(), window), label: sendWindowLabel(window) },
    activeRun: activeRun !== null,
    activeRunId: activeRun ? activeRun.id : null,
    ratePerHour: sendRatePerHour(client.send_rate_per_hour),
    autoPause: {
      target: targetStatus.target,
      period: targetStatus.period,
      leadsThisPeriod: targetStatus.leadsThisPeriod,
      met: targetStatus.met,
      nextPeriod: targetStatus.nextPeriod,
    },
    recentLeads,
    recentInbound,
    recentOptOuts,
    fetchedAt: new Date().toISOString(),
  };
}
