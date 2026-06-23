// /api/campaign — the paced, resumable outbound SMS engine. (Session 3, Module 3)
//
// AUTH: both POST and GET require the admin cookie (isAuthed) — this endpoint sends real
// SMS and spends money, so it must never be world-callable.
//
// POST  run or resume the send over ELIGIBLE contacts only.
//       Body: { dryRun?: boolean, limit?: number, confirm?: boolean, note?: string }
//         - dryRun  → report eligible count + per-variant split, send NOTHING (always safe).
//         - real send requires confirm:true AND the send-window check to pass.
//       `limit` caps how many eligible contacts are FETCHED (and thus attempted), not the
//       number actually sent — overflow/already-claimed rows are skipped, so sends <= limit.
// GET   progress JSON: { eligible, sent, pending, in_flight, failed, suppressed, opted_out }.
//
// Compliance (load-bearing): the ONLY contacts texted are those returned by
// getEligibleContacts() (phone present, not suppressed, scrub_status='clean',
// send_status='not_sent'). Each contact is atomically CLAIMED (not_sent -> sending)
// before its send, so a crash or concurrent re-run can never double-text. Rendering
// + single-segment enforcement come from lib/sms.ts — never re-implemented here.

import { NextResponse } from "next/server";
import { isAuthed } from "@/app/actions";
import {
  getEligibleContacts,
  claimForSend,
  setVariant,
  setSendStatus,
  recordMessage,
  createCampaignRun,
  finishCampaignRun,
  hasActiveCampaignRun,
  getSendProgress,
  type Contact,
} from "@/lib/db";
import { renderMessage, withinSingleSegment, type Variant } from "@/lib/sms";
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

function bizName(): string {
  return process.env.BIZ_NAME?.trim() || "Talan Window Cleaning";
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
    // AUTH GATE — this endpoint sends real SMS; never allow it unauthenticated.
    if (!(await isAuthed())) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const confirm = body.confirm === true;
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : undefined;
    const note = typeof body.note === "string" ? body.note : undefined;

    const variants = activeVariants();
    const eligible = await getEligibleContacts(limit);

    // ---- Dry run: report only, never send. -------------------------------
    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        eligible: eligible.length,
        perVariant: variantSplit(eligible.length, variants),
        variants,
        sendWindow: { within: withinSendWindow(), label: sendWindowLabel() },
        ratePerHour: sendRatePerHour(),
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
    if (!withinSendWindow()) {
      return NextResponse.json(
        {
          error: "outside_send_window",
          message: `Sending is only allowed within ${sendWindowLabel()}.`,
          window: sendWindowLabel(),
        },
        { status: 409 }
      );
    }
    if (eligible.length === 0) {
      return NextResponse.json({ ran: true, eligible: 0, sent: 0, failed: 0, note: "nothing eligible" });
    }

    // Concurrent-run guard: refuse if another run is in flight, so two callers can't
    // both blast the list and defeat pacing. (Per-contact atomic claim still prevents
    // double-texting even if this guard is raced.)
    if (await hasActiveCampaignRun()) {
      return NextResponse.json(
        { error: "campaign_already_running", message: "Another campaign run is in flight; try again shortly." },
        { status: 409 }
      );
    }

    // ---- Paced, resumable send loop. -------------------------------------
    const runId = await createCampaignRun(eligible.length, note);
    const delay = pacingDelayMs();
    const result = await runSend(eligible, variants, delay);
    await finishCampaignRun(
      runId,
      result.sent,
      note ??
        `sent=${result.sent} failed=${result.failed} overflow=${result.skippedOverflow}` +
          (result.stoppedForWindow ? " stopped=send_window" : "")
    );

    return NextResponse.json({
      ran: true,
      runId,
      eligible: eligible.length,
      attempted: result.attempted,
      sent: result.sent,
      failed: result.failed,
      skippedOverflow: result.skippedOverflow,
      skippedClaimed: result.skippedClaimed,
      stoppedForWindow: result.stoppedForWindow,
      perVariant: result.perVariant,
      ratePerHour: sendRatePerHour(),
    });
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
  eligible: Contact[],
  variants: Variant[],
  delayMs: number
): Promise<RunResult> {
  const biz = bizName();
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
    if (!withinSendWindow()) {
      r.stoppedForWindow = true;
      console.warn(`[campaign] send window closed mid-run; stopping after ${r.attempted} attempts`);
      break;
    }

    const c = eligible[i];
    const variant = variantFor(attemptIndex, variants);
    const body = renderMessage(
      variant,
      { firstName: c.first_name, zip: c.zip, address: c.address },
      biz
    );

    // Never send a 2-segment message. Drain the contact (claim -> 'failed') so it
    // leaves the eligible pool instead of being re-rendered+re-skipped on every run.
    // Does NOT advance attemptIndex (no message was assigned to a real send).
    if (!withinSingleSegment(body)) {
      r.skippedOverflow++;
      console.warn(`[campaign] overflow contact=${c.id} variant=${variant} len=${body.length} -> failed`);
      if (await claimForSend(c.id)) await setSendStatus(c.id, "failed");
      continue;
    }

    // Atomic claim: only proceed if THIS run flipped not_sent -> sending.
    // Guarantees no double-text under crash or concurrent re-run.
    const claimed = await claimForSend(c.id);
    if (!claimed) {
      r.skippedClaimed++;
      continue;
    }

    // Committed to attempting this contact — record the assigned variant (matches
    // perVariant) and advance the round-robin so the split stays balanced.
    await setVariant(c.id, variant);
    r.perVariant[variant]++;
    r.attempted++;
    attemptIndex++;

    const phone = c.phone as string; // eligibility guarantees non-null
    const res = await sendOne(phone, body);
    if (res.ok) {
      await recordMessage({
        contactId: c.id,
        direction: "outbound",
        body,
        twilioSid: res.sid,
        status: res.status,
      });
      await setSendStatus(c.id, "sent");
      r.sent++;
    } else {
      // Store Twilio's terminal vocabulary ('failed'); log the error code separately.
      await recordMessage({
        contactId: c.id,
        direction: "outbound",
        body,
        twilioSid: null,
        status: "failed",
      });
      await setSendStatus(c.id, "failed");
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

export async function GET() {
  try {
    if (!(await isAuthed())) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const progress = await getSendProgress();
    return NextResponse.json(progress);
  } catch (err) {
    console.error("[campaign] progress failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "progress_failed" }, { status: 500 });
  }
}
