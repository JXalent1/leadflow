// /api/cron/send — the SERVER-SIDE send driver. (Server-side sender, 2026-06-30.)
//
// THE FIX: the outbound send used to advance only while the operator's browser tab (the client
// pipeline driver) was open and focused — close/background it and the send froze. This endpoint
// moves the DRIVING to the server. Once a minute (Vercel Cron), it finds every campaign the
// operator has armed (campaigns.auto_send = true) whose client is active, and advances each by ONE
// paced batch through the EXACT same path the browser used — lib/send-batch.sendCampaignBatch —
// which calls getEligibleContacts + the atomic claimForSend + the send-window gate. So the operator
// hits Run, the campaign is marked auto_send, and the server drains it to completion on its own.
//
// AUTH (not publicly triggerable): every request must present CRON_SECRET. Vercel Cron sends it as
// `Authorization: Bearer <CRON_SECRET>` automatically; an external uptime pinger can send the same
// header (or `x-cron-secret: <secret>`). Anything without it gets 401. We also fail CLOSED when
// CRON_SECRET is unset — better to send nothing than to expose an unauthenticated send trigger.
//
// OVERLAP-SAFE / RE-ENTRANT: if two ticks overlap, both adopt the same active run and race the
// eligible list, but the atomic per-contact claim (not_sent -> sending in one statement) still
// guarantees each contact is claimed by exactly one — NO double-send at any concurrency.
//
// UNCHANGED GUARANTEES: this endpoint adds NO eligibility/suppression/window logic of its own. It
// only discovers which campaigns to drive and calls the shared batch. Suppression, the send window,
// opt-out, eligibility, and the lead-target auto-pause are all enforced inside sendCampaignBatch.

import { NextResponse } from "next/server";
import { getAutoSendTargets } from "@/lib/campaigns";
import { getClientById } from "@/lib/clients";
import { sendCampaignBatch, type SendBatchResult } from "@/lib/send-batch";
import { cronBatchSize } from "@/lib/pipeline";

// A paced batch can run up to ~a minute; allow the platform max as a safety ceiling.
export const maxDuration = 300;
// Never cache — this mutates send state and must run fresh every tick.
export const dynamic = "force-dynamic";

/** True only if the request carries the configured CRON_SECRET. Fails closed when it is unset. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false; // no secret configured → refuse (never an open send trigger)
  const bearer = req.headers.get("authorization");
  if (bearer && bearer === `Bearer ${secret}`) return true;
  // Allow an external pinger (cron-job.org etc.) to authenticate with a plain header too.
  return req.headers.get("x-cron-secret") === secret;
}

/** One-line summary of a batch outcome, for the JSON response + logs (no PII). */
function summarize(r: SendBatchResult): Record<string, unknown> {
  switch (r.kind) {
    case "sent":
      return { kind: r.kind, sent: r.sent, failed: r.failed, done: r.done, stoppedForWindow: r.stoppedForWindow };
    case "drained":
      return { kind: r.kind, done: true };
    case "target_met":
      return { kind: r.kind, leadsThisPeriod: r.leadsThisPeriod, target: r.target };
    case "outside_window":
      return { kind: r.kind, window: r.window };
    case "already_running":
      return { kind: r.kind };
  }
}

/** Drive every armed campaign by one paced batch. */
async function drain(): Promise<NextResponse> {
  const targets = await getAutoSendTargets();
  const results: Record<string, unknown>[] = [];

  // Sequential, not parallel: each batch paces internally (sleeping between sends) and we don't want
  // N campaigns' batches contending; the atomic claim makes either order safe regardless.
  for (const t of targets) {
    try {
      const client = await getClientById(t.clientId);
      if (!client) {
        results.push({ clientId: t.clientId, campaignId: t.campaignId, kind: "skipped_no_client" });
        continue;
      }
      const r = await sendCampaignBatch({
        client,
        campaignId: t.campaignId,
        limit: cronBatchSize(client.send_rate_per_hour),
        note: "cron drain",
        adoptActiveRun: true, // adopt any in-flight run; the atomic claim keeps overlap safe
      });
      results.push({ clientId: t.clientId, campaignId: t.campaignId, ...summarize(r) });
    } catch (err) {
      // One campaign's failure must never halt the others. Log server-side; expose only a label.
      console.error(
        `[cron/send] batch failed client=${t.clientId} campaign=${t.campaignId}:`,
        err instanceof Error ? err.message : String(err)
      );
      results.push({ clientId: t.clientId, campaignId: t.campaignId, error: "batch_failed" });
    }
  }

  return NextResponse.json({ ran: true, drove: targets.length, results });
}

// Vercel Cron invokes via GET; an external pinger may use either. Both require the secret.
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return await drain();
  } catch (err) {
    console.error("[cron/send] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "cron_send_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
