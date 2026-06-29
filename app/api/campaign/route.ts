// /api/campaign — the paced, resumable outbound SMS engine. (Session 3, Module 3)
//
// AUTH: both POST and GET require an operator session (requireOperator) — this endpoint sends real
// SMS and spends money, so it must never be world-callable.
//
// POST  run or resume ONE BATCH of the send over ELIGIBLE contacts only.
//       Body: { dryRun?: boolean, limit?: number, confirm?: boolean, note?: string, runId?: number }
//         - dryRun  → report eligible count + per-variant split, send NOTHING (always safe).
//         - real send requires confirm:true AND the send-window check to pass.
//       `limit` caps how many eligible contacts are FETCHED (and thus attempted), not the
//       number actually sent — overflow/already-claimed rows are skipped, so sends <= limit.
//
//       DRIVEN MULTI-BATCH (v2 Module V3): the client-side pipeline driver calls this repeatedly,
//       one small batch at a time (so no single call hits the function timeout), passing back the
//       `runId` it received so it continues its OWN run. The response carries `done` (true when no
//       eligible contacts remain, or the window closed mid-batch) so the driver knows when to stop.
//       The run is closed (finished_at) only on the batch that drains it — fixing the old stall
//       where a timed-out single long run never closed and then blocked the next "Start send".
//       Each batch STILL goes through getEligibleContacts + the atomic claimForSend (with the V2
//       opt-out re-check), so suppression/eligibility hold on every batch — auto-resume never
//       bypasses them.
// GET   progress JSON: { eligible, sent, pending, in_flight, failed, suppressed, opted_out }.
//
// Compliance (load-bearing): the ONLY contacts texted are those returned by
// getEligibleContacts() (phone present, not suppressed, scrub_status='clean',
// send_status='not_sent'). Each contact is atomically CLAIMED (not_sent -> sending)
// before its send, so a crash or concurrent re-run can never double-text. Rendering
// + single-segment enforcement come from lib/sms.ts — never re-implemented here.

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/guard";
import { resolveClientIdForUser } from "@/lib/access";
import {
  getEligibleContacts,
  claimForSend,
  setVariant,
  setSendStatus,
  recordMessage,
  getSendProgress,
  type Contact,
} from "@/lib/db";
import {
  createCampaignRun,
  finishCampaignRun,
  touchCampaignRun,
  getActiveCampaignRun,
} from "@/lib/campaign-runs";
import { requestedClientId, campaignIdFromRequest } from "@/lib/request-client";
import { resolveCampaignForClient } from "@/lib/campaigns";
import {
  getClientById,
  clientSender,
  clientWindow,
  clientBizName,
  clientOptOutInstruction,
  type Client,
} from "@/lib/clients";
import { getTargetStatus } from "@/lib/auto-pause";
import { renderMessage, withinSegmentLimit, MAX_MESSAGE_SEGMENTS, segmentInfo, type Variant } from "@/lib/sms";
import {
  sendOne,
  withinSendWindow,
  sendWindowLabel,
  pacingDelayMs,
  sendRatePerHour,
  sleep,
} from "@/lib/twilio";

// A paced run can outlast the default function window; allow the platform max.
export const maxDuration = 300;

const DEFAULT_VARIANTS: Variant[] = ["A", "B", "C"];

/** Active A/B cells, from env AB_VARIANTS (e.g. "A,B"); defaults to A/B/C. */
function activeVariants(): Variant[] {
  const raw = process.env.AB_VARIANTS?.trim();
  if (!raw) return DEFAULT_VARIANTS;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Variant => s === "A" || s === "B" || s === "C");
  return parsed.length > 0 ? parsed : DEFAULT_VARIANTS;
}

/** Deterministic round-robin variant for a contact at position `index`. */
function variantFor(index: number, variants: Variant[]): Variant {
  return variants[index % variants.length];
}

/**
 * Per-variant split projection for the dry-run report. This assumes every eligible
 * contact is sent in order with no skips; a real run advances the variant index only
 * on contacts it actually attempts (overflow/already-claimed rows are skipped), so the
 * realized split stays balanced among sent messages even if it diverges slightly here.
 */
function variantSplit(count: number, variants: Variant[]): Record<string, number> {
  const split: Record<string, number> = {};
  for (const v of variants) split[v] = 0;
  for (let i = 0; i < count; i++) split[variantFor(i, variants)]++;
  return split;
}

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

    // A send targets exactly ONE campaign (default = the client's pilot campaign). Eligibility,
    // the run record, and the concurrent-run guard are all scoped to it; suppression stays
    // client-level (the eligibility query excludes any phone in this client's opt_outs).
    const campaign = await resolveCampaignForClient(clientId, campaignIdFromRequest(req));
    if (!campaign) {
      return NextResponse.json({ error: "no_campaign" }, { status: 404 });
    }
    const campaignId = campaign.id;

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const confirm = body.confirm === true;
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : undefined;
    const note = typeof body.note === "string" ? body.note : undefined;
    // The run the driver is already continuing (omitted on the first batch of a fresh drive).
    const requestedRunId =
      typeof body.runId === "number" && Number.isInteger(body.runId) && body.runId > 0
        ? body.runId
        : undefined;

    const variants = activeVariants();
    const eligible = await getEligibleContacts(clientId, { campaignId, limit });

    // ---- Dry run: report only, never send. -------------------------------
    if (dryRun) {
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

    // ---- Safety guards for a REAL send. ----------------------------------
    if (!confirm) {
      return NextResponse.json(
        {
          error: "confirmation_required",
          message: "Refusing to send without { confirm: true }. Use { dryRun: true } to preview.",
          eligible: eligible.length,
        },
        { status: 400 }
      );
    }
    if (!withinSendWindow(new Date(), window)) {
      return NextResponse.json(
        {
          error: "outside_send_window",
          message: `Sending is only allowed within ${sendWindowLabel(window)}.`,
          window: sendWindowLabel(window),
        },
        { status: 409 }
      );
    }
    // ---- Concurrent-run guard + driver-OWN-run continuation. -------------
    // Resolve any in-flight run for this client+campaign. The driver passes back the runId it is
    // driving so it can CONTINUE its own run; a caller with no runId (or a stale/foreign one) is
    // blocked while a different run is active. (The per-contact atomic claim is still the real
    // no-double-text guarantee even if this guard is raced.)
    const active = await getActiveCampaignRun(clientId, campaignId);

    // ---- Lead-target auto-pause (v2 Module V6): deliver-then-stop. --------
    // A BUSINESS gate layered ON TOP of suppression/eligibility — NEVER a relaxation. If the client
    // has already hit its lead target for the current period, refuse to send (no wasted texts /
    // credits past the goal); sending resumes automatically when the period rolls over or the
    // operator raises the target. Enforced HERE in the send route (read fresh each batch), so
    // hitting Run can never over-send — it is not merely a UI guard. This check only ADDS a stop:
    // a target NOT met does nothing to suppression (getEligibleContacts/claimForSend still gate
    // every contact), and a target met never touches eligibility — it just halts this client.
    const targetStatus = await getTargetStatus(client, new Date());
    if (targetStatus.met) {
      // If THIS driver owns the active run, close it so it doesn't linger open blocking the resume.
      if (active && requestedRunId === active.id) {
        await finishCampaignRun(
          clientId,
          active.id,
          0,
          `paused: target met (${targetStatus.leadsThisPeriod}/${targetStatus.target} this ${targetStatus.period})`
        );
      }
      return NextResponse.json({
        ran: false,
        done: true,
        paused: true,
        reason: "target_met",
        clientId,
        campaignId,
        target: targetStatus.target,
        period: targetStatus.period,
        leadsThisPeriod: targetStatus.leadsThisPeriod,
        nextPeriod: targetStatus.nextPeriod,
        message: `Target met (${targetStatus.leadsThisPeriod}/${targetStatus.target} this ${targetStatus.period}) — paused until ${targetStatus.nextPeriod}`,
      });
    }

    let runId: number;
    if (active) {
      if (requestedRunId === active.id) {
        runId = active.id; // continuing our OWN run — allowed
      } else {
        // Someone else's run is active (or a fresh caller with no runId): block, but hand back the
        // active run id so a resuming driver can adopt it and continue from DB state.
        return NextResponse.json(
          {
            error: "campaign_already_running",
            message: "Another campaign run is in flight; try again shortly.",
            runId: active.id,
          },
          { status: 409 }
        );
      }
    } else {
      // No active run (none yet, or a prior driver's run has gone stale/finished) → start fresh.
      // This is also the RESUME-after-expiry path: requestedRunId may be set but no longer active.
      if (eligible.length === 0) {
        return NextResponse.json({ ran: true, done: true, eligible: 0, sent: 0, failed: 0 });
      }
      runId = await createCampaignRun(clientId, campaignId, eligible.length, note);
    }

    // Continuing an OWN run with nothing left to send → close it out (drained).
    if (eligible.length === 0) {
      await finishCampaignRun(clientId, runId, 0, note ?? "drained (nothing eligible)");
      return NextResponse.json({ ran: true, runId, done: true, eligible: 0, sent: 0, failed: 0 });
    }

    // ---- Paced send of THIS batch. ---------------------------------------
    // The run is now OPEN. If anything below throws (a DB error in runSend, a Twilio SDK throw,
    // the finalize writes), the finally block closes it — an exception must NEVER leave a run open
    // to 409-block the next Run (that would re-introduce the very stall V3 fixed). The staleness
    // guard would self-heal in ≤6 min anyway, but closing immediately drops that blackout to zero.
    // (Review V3 correctness M1.)
    const delay = pacingDelayMs(client.send_rate_per_hour);
    let runClosed = false;
    try {
      const result = await runSend(client, eligible, variants, delay);

      // Are there still eligible contacts after this batch? (Cheap indexed probe — same predicate.)
      // The run closes (finished_at) ONLY when nothing remains, or the window shut mid-batch; until
      // then it stays open + heartbeated so it keeps representing the ongoing drive.
      const remaining = result.stoppedForWindow
        ? 1 // window closed mid-batch — stop now; leave the rest for a later resume
        : (await getEligibleContacts(clientId, { campaignId, limit: 1 })).length;
      const done = result.stoppedForWindow || remaining === 0;

      if (done) {
        await finishCampaignRun(
          clientId,
          runId,
          result.sent,
          note ??
            `sent=${result.sent} failed=${result.failed} overflow=${result.skippedOverflow}` +
              (result.stoppedForWindow ? " stopped=send_window" : "")
        );
      } else {
        await touchCampaignRun(clientId, runId, result.sent);
      }
      runClosed = true; // run is finalized (closed or heartbeated) — finally must not touch it

      return NextResponse.json({
        ran: true,
        runId,
        done,
        clientId,
        campaignId,
        eligible: eligible.length,
        attempted: result.attempted,
        sent: result.sent,
        failed: result.failed,
        skippedOverflow: result.skippedOverflow,
        skippedClaimed: result.skippedClaimed,
        stoppedForWindow: result.stoppedForWindow,
        perVariant: result.perVariant,
        ratePerHour: sendRatePerHour(client.send_rate_per_hour),
      });
    } finally {
      // Only fires when the try threw before finalizing — close the run so it can't strand open.
      // Any contacts actually sent this batch are already committed as 'sent' (so never re-texted);
      // the operator can immediately re-Run, which starts a fresh run over the remaining not_sent.
      if (!runClosed) {
        await finishCampaignRun(clientId, runId, 0, "aborted (exception during send batch)").catch(
          () => {}
        );
      }
    }
  } catch (err) {
    // Log full detail server-side; return a generic label (raw errors can carry
    // Twilio account IDs / DB connection fragments — never leak them to the client).
    console.error("[campaign] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "campaign_failed" }, { status: 500 });
  }
}

interface RunResult {
  attempted: number;
  sent: number;
  failed: number;
  skippedOverflow: number;
  skippedClaimed: number;
  stoppedForWindow: boolean;
  perVariant: Record<string, number>;
}

/**
 * Walk the eligible list, claim each contact atomically, render, enforce one
 * segment, send, and record state — pacing between sends. Returns a tally.
 *
 * The send window is re-checked every iteration so a run that begins late never
 * texts past the window's close. The A/B variant is assigned by `attemptIndex`
 * (advanced only for contacts we actually send) so the realized split stays balanced
 * even when some rows are skipped.
 */
async function runSend(
  client: Client,
  eligible: Contact[],
  variants: Variant[],
  delayMs: number
): Promise<RunResult> {
  const clientId = client.id;
  const biz = clientBizName(client);
  const template = client.message_template ?? "";
  const optOutLine = clientOptOutInstruction(client);
  const sender = clientSender(client);
  const window = clientWindow(client);
  const r: RunResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedOverflow: 0,
    skippedClaimed: 0,
    stoppedForWindow: false,
    perVariant: {},
  };
  for (const v of variants) r.perVariant[v] = 0;

  let attemptIndex = 0; // advances only on contacts we actually attempt to send
  for (let i = 0; i < eligible.length; i++) {
    // Re-check the window each iteration — never keep sending past its close.
    if (!withinSendWindow(new Date(), window)) {
      r.stoppedForWindow = true;
      console.warn(`[campaign] send window closed mid-run; stopping after ${r.attempted} attempts`);
      break;
    }

    const c = eligible[i];
    const variant = variantFor(attemptIndex, variants);
    // Body comes from THIS client's template (one template per client in v2). The variant is
    // still recorded for provenance; it no longer drives copy (each client has one template).
    const body = renderMessage(
      template,
      { firstName: c.first_name, zip: c.zip, address: c.address },
      biz,
      optOutLine
    );

    // Messages may be multi-segment up to MAX_MESSAGE_SEGMENTS. Only a message OVER the cap is
    // drained (claim -> 'failed') so it leaves the eligible pool instead of being re-rendered +
    // re-skipped every run — a hard ceiling so a runaway template can't blast many segments of cost.
    // Does NOT advance attemptIndex (no message was assigned to a real send).
    if (!withinSegmentLimit(body)) {
      r.skippedOverflow++;
      console.warn(`[campaign] over segment cap (>${MAX_MESSAGE_SEGMENTS}) contact=${c.id} variant=${variant} len=${body.length} segs=${segmentInfo(body).segments} -> failed`);
      if (await claimForSend(clientId, c.id)) await setSendStatus(clientId, c.id, "failed");
      continue;
    }

    // Atomic claim: only proceed if THIS run flipped not_sent -> sending.
    // Guarantees no double-text under crash or concurrent re-run.
    const claimed = await claimForSend(clientId, c.id);
    if (!claimed) {
      r.skippedClaimed++;
      continue;
    }

    // Committed to attempting this contact — record the assigned variant (matches
    // perVariant) and advance the round-robin so the split stays balanced.
    await setVariant(clientId, c.id, variant);
    r.perVariant[variant]++;
    r.attempted++;
    attemptIndex++;

    const phone = c.phone as string; // eligibility guarantees non-null
    const res = await sendOne(phone, body, sender);
    if (res.ok) {
      await recordMessage({
        clientId,
        contactId: c.id,
        direction: "outbound",
        body,
        twilioSid: res.sid,
        status: res.status,
      });
      await setSendStatus(clientId, c.id, "sent");
      r.sent++;
    } else {
      // Store Twilio's terminal vocabulary ('failed'); log the error code separately.
      await recordMessage({
        clientId,
        contactId: c.id,
        direction: "outbound",
        body,
        twilioSid: null,
        status: "failed",
      });
      await setSendStatus(clientId, c.id, "failed");
      r.failed++;
      console.error(`[campaign] send failed contact=${c.id} code=${res.code ?? "?"}`);
    }

    // Pace AFTER marking state, so a timeout during the wait never strands a send.
    // Skipped contacts (overflow / already-claimed) hit `continue` above and do NOT
    // consume a pacing slot — pacing governs the outbound SMS rate, not iteration rate.
    const hasMore = i < eligible.length - 1;
    if (hasMore && delayMs > 0) await sleep(delayMs);
  }

  return r;
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
