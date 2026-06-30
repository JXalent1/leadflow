// /api/campaign — the paced, resumable outbound SMS engine. (Session 3, Module 3)
//
// AUTH: both POST and GET require an operator session (requireOperator) — this endpoint sends real
// SMS and spends money, so it must never be world-callable.
//
// POST
//   { autoSend: true|false }            arm/pause SERVER-SIDE sending: set the campaign's auto_send
//                                       flag so the per-minute cron (/api/cron/send) drains the
//                                       remaining eligible contacts WITHOUT the browser tab open.
//                                       Returns the live progress snapshot. (Server-side sender,
//                                       2026-06-30 — this is now the Run button's primary job.)
//   { dryRun: true }                    report eligible count + per-variant split, send NOTHING.
//   { confirm: true, limit?, runId? }   run or resume ONE BATCH over ELIGIBLE contacts (the legacy
//                                       browser-driven path; still works, still resumable).
//
// The actual per-batch send (window gate, atomic claimForSend, paced Twilio send, run lifecycle)
// lives in ONE shared place — lib/send-batch.sendCampaignBatch — called by BOTH this route and the
// cron. Suppression/eligibility/no-double-send are enforced there and are unchanged.
//
// GET   progress JSON: { eligible, sent, pending, in_flight, failed, suppressed, opted_out }.

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import { getEligibleContacts, getSendProgress } from "@/lib/db";
import { requestedClientId, campaignIdFromRequest } from "@/lib/request-client";
import { resolveCampaignForClient, setCampaignAutoSend } from "@/lib/campaigns";
import { getClientById, clientWindow } from "@/lib/clients";
import {
  sendCampaignBatch,
  activeVariants,
  variantSplit,
} from "@/lib/send-batch";
import { withinSendWindow, sendWindowLabel, sendRatePerHour } from "@/lib/twilio";

// A paced run can outlast the default function window; allow the platform max.
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    // AUTH GATE — operator only; this endpoint sends real SMS.
    const g = await requireOperator();
    if (!g.ok) return g.response;

    // Resolve the operator's selected client. All scoping + send config (window, rate, sender,
    // copy) come from this record — never env.
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const client = await getClientById(clientId);
    if (!client) {
      return NextResponse.json({ error: "client_not_found" }, { status: 404 });
    }
    const window = clientWindow(client);

    // A send targets exactly ONE campaign (default = the client's pilot campaign).
    const campaign = await resolveCampaignForClient(clientId, campaignIdFromRequest(req));
    if (!campaign) {
      return NextResponse.json({ error: "no_campaign" }, { status: 404 });
    }
    const campaignId = campaign.id;

    const body = await req.json().catch(() => ({}));

    // ---- auto_send control: arm/pause SERVER-SIDE sending (cron-driven). ---------------
    // The Run button calls this to hand the drive to the server; Pause clears it. It does NOT send
    // here — it just flips the flag the cron reads — so suppression/window/eligibility are untouched.
    if (typeof body.autoSend === "boolean") {
      await setCampaignAutoSend(clientId, campaignId, body.autoSend);
      const progress = await getSendProgress(clientId, campaignId);
      return NextResponse.json({
        autoSend: body.autoSend,
        clientId,
        campaignId,
        ...progress,
        sendWindow: { within: withinSendWindow(new Date(), window), label: sendWindowLabel(window) },
        ratePerHour: sendRatePerHour(client.send_rate_per_hour),
      });
    }

    const dryRun = body.dryRun === true;
    const confirm = body.confirm === true;
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : undefined;
    const note = typeof body.note === "string" ? body.note : undefined;
    const requestedRunId =
      typeof body.runId === "number" && Number.isInteger(body.runId) && body.runId > 0
        ? body.runId
        : undefined;

    // ---- Dry run / unconfirmed: report eligible only, never send. ----------------------
    if (dryRun || !confirm) {
      const eligible = await getEligibleContacts(clientId, { campaignId, limit });
      if (dryRun) {
        const variants = activeVariants();
        return NextResponse.json({
          dryRun: true,
          clientId,
          campaignId,
          eligible: eligible.length,
          perVariant: variantSplit(eligible.length, variants),
          variants,
          sendWindow: { within: withinSendWindow(new Date(), window), label: sendWindowLabel(window) },
          ratePerHour: sendRatePerHour(client.send_rate_per_hour),
        });
      }
      return NextResponse.json(
        {
          error: "confirmation_required",
          message: "Refusing to send without { confirm: true }. Use { dryRun: true } to preview.",
          eligible: eligible.length,
        },
        { status: 400 }
      );
    }

    // ---- Real send of ONE batch through the SHARED path (same as the cron). ------------
    const result = await sendCampaignBatch({ client, campaignId, limit, note, requestedRunId });
    switch (result.kind) {
      case "outside_window":
        return NextResponse.json(
          {
            error: "outside_send_window",
            message: `Sending is only allowed within ${result.window}.`,
            window: result.window,
          },
          { status: 409 }
        );
      case "already_running":
        return NextResponse.json(
          {
            error: "campaign_already_running",
            message: "Another campaign run is in flight; try again shortly.",
            runId: result.runId,
          },
          { status: 409 }
        );
      case "target_met":
        return NextResponse.json({
          ran: false,
          done: true,
          paused: true,
          reason: "target_met",
          clientId,
          campaignId,
          target: result.target,
          period: result.period,
          leadsThisPeriod: result.leadsThisPeriod,
          nextPeriod: result.nextPeriod,
          message: result.message,
        });
      case "drained":
        return NextResponse.json({ ran: true, runId: result.runId, done: true, eligible: 0, sent: 0, failed: 0 });
      case "sent":
        return NextResponse.json({
          ran: true,
          runId: result.runId,
          done: result.done,
          clientId,
          campaignId,
          eligible: result.eligible,
          attempted: result.attempted,
          sent: result.sent,
          failed: result.failed,
          skippedOverflow: result.skippedOverflow,
          skippedClaimed: result.skippedClaimed,
          stoppedForWindow: result.stoppedForWindow,
          perVariant: result.perVariant,
          ratePerHour: result.ratePerHour,
        });
    }
  } catch (err) {
    // Log full detail server-side; return a generic label (raw errors can carry
    // Twilio account IDs / DB connection fragments — never leak them to the client).
    console.error("[campaign] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "campaign_failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const g = await requireOperator();
    if (!g.ok) return g.response;
    const clientId = resolveClientIdForUser(g.user, requestedClientId(req));
    if (clientId === null) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const campaign = await resolveCampaignForClient(clientId, campaignIdFromRequest(req));
    const progress = await getSendProgress(clientId, campaign?.id);
    return NextResponse.json(progress);
  } catch (err) {
    console.error("[campaign] progress failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "progress_failed" }, { status: 500 });
  }
}
