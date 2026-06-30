/**
 * lib/send-batch.ts — the ONE paced-send implementation, shared by the operator route and the cron.
 * (Server-side sender, 2026-06-30.)
 *
 * Extracted verbatim from app/api/campaign/route.ts so there is a SINGLE place that drives one
 * batch of the outbound send. Both callers go through this:
 *   - app/api/campaign/route.ts   — the operator's Run (a driver passes back its OWN runId).
 *   - app/api/cron/send/route.ts  — the per-minute server cron (adopts any active run, no browser).
 *
 * COMPLIANCE IS UNCHANGED AND LIVES BELOW UNTOUCHED:
 *   - The ONLY contacts texted are those returned by getEligibleContacts() (phone present, not
 *     suppressed, scrub_status='clean', send_status='not_sent', not in the client's opt_outs).
 *   - Each contact is atomically CLAIMED (not_sent -> sending, with an opt-out re-check) before its
 *     send, so a crash or a concurrent re-run — INCLUDING two overlapping cron ticks — can never
 *     double-text. The atomic claim is the real no-double-send guarantee; the active-run guard is
 *     only an advisory throttle on top of it.
 *   - The send window is re-checked at the top AND every iteration, so a batch never texts outside it.
 *   - Rendering + single-segment enforcement come from lib/sms.ts — never re-implemented here.
 *
 * sendCampaignBatch returns a plain discriminated result (NOT a NextResponse); each route maps it to
 * its own HTTP shape. The auto_send flag is cleared here ONLY when the eligible set genuinely drains
 * (so a completed campaign stops being driven); a window/target pause leaves it ON so sending resumes.
 */

import {
  getEligibleContacts,
  claimForSend,
  setVariant,
  setSendStatus,
  recordMessage,
  type Contact,
} from "@/lib/db";
import {
  createCampaignRun,
  finishCampaignRun,
  touchCampaignRun,
  getActiveCampaignRun,
} from "@/lib/campaign-runs";
import { setCampaignAutoSend } from "@/lib/campaigns";
import {
  clientSender,
  clientWindow,
  clientBizName,
  clientOptOutInstruction,
  type Client,
} from "@/lib/clients";
import { getTargetStatus } from "@/lib/auto-pause";
import {
  renderMessage,
  withinSegmentLimit,
  MAX_MESSAGE_SEGMENTS,
  segmentInfo,
  type Variant,
} from "@/lib/sms";
import {
  sendOne,
  withinSendWindow,
  sendWindowLabel,
  pacingDelayMs,
  sendRatePerHour,
  sleep,
} from "@/lib/twilio";

const DEFAULT_VARIANTS: Variant[] = ["A", "B", "C"];

/** Active A/B cells, from env AB_VARIANTS (e.g. "A,B"); defaults to A/B/C. */
export function activeVariants(): Variant[] {
  const raw = process.env.AB_VARIANTS?.trim();
  if (!raw) return DEFAULT_VARIANTS;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Variant => s === "A" || s === "B" || s === "C");
  return parsed.length > 0 ? parsed : DEFAULT_VARIANTS;
}

/** Deterministic round-robin variant for a contact at position `index`. */
export function variantFor(index: number, variants: Variant[]): Variant {
  return variants[index % variants.length];
}

/**
 * Per-variant split projection for the dry-run report. This assumes every eligible
 * contact is sent in order with no skips; a real run advances the variant index only
 * on contacts it actually attempts (overflow/already-claimed rows are skipped), so the
 * realized split stays balanced among sent messages even if it diverges slightly here.
 */
export function variantSplit(count: number, variants: Variant[]): Record<string, number> {
  const split: Record<string, number> = {};
  for (const v of variants) split[v] = 0;
  for (let i = 0; i < count; i++) split[variantFor(i, variants)]++;
  return split;
}

export interface RunResult {
  attempted: number;
  sent: number;
  failed: number;
  skippedOverflow: number;
  skippedClaimed: number;
  stoppedForWindow: boolean;
  perVariant: Record<string, number>;
}

/** Options for one driven batch. */
export interface SendBatchOptions {
  client: Client;
  campaignId: number;
  /** Cap how many eligible contacts are FETCHED (and thus attempted) this batch. */
  limit?: number;
  note?: string;
  /** The run id a browser driver is continuing (route only); ignored by the cron. */
  requestedRunId?: number;
  /**
   * Cron mode: adopt whatever run is currently active instead of returning "already_running".
   * Safe because the atomic per-contact claim — not this guard — is the no-double-send guarantee.
   */
  adoptActiveRun?: boolean;
  /** Clock injection for tests; defaults to now. Only gates the top-level window + target checks. */
  now?: Date;
}

/** Discriminated outcome of one batch. Each route maps this to its own HTTP response. */
export type SendBatchResult =
  | {
      kind: "target_met";
      clientId: number;
      campaignId: number;
      target: number;
      period: string;
      leadsThisPeriod: number;
      nextPeriod: string;
      message: string;
    }
  | { kind: "outside_window"; clientId: number; campaignId: number; window: string }
  | { kind: "already_running"; runId: number }
  | { kind: "drained"; clientId: number; campaignId: number; runId?: number }
  | {
      kind: "sent";
      clientId: number;
      campaignId: number;
      runId: number;
      done: boolean;
      eligible: number;
      attempted: number;
      sent: number;
      failed: number;
      skippedOverflow: number;
      skippedClaimed: number;
      stoppedForWindow: boolean;
      perVariant: Record<string, number>;
      ratePerHour: number;
    };

/**
 * Run or resume ONE batch of the send over ELIGIBLE contacts only, for one client + campaign.
 *
 * Order (identical to the original /api/campaign POST): send-window gate → resolve the active run →
 * lead-target auto-pause gate → fetch eligible → resolve/own/create the run → paced send → finalize.
 * The caller is responsible for any auth + confirm gate BEFORE calling this.
 */
export async function sendCampaignBatch(opts: SendBatchOptions): Promise<SendBatchResult> {
  const { client, campaignId, limit, note, requestedRunId, adoptActiveRun = false } = opts;
  const now = opts.now ?? new Date();
  const clientId = client.id;
  const window = clientWindow(client);
  const variants = activeVariants();

  // ---- Send-window gate. Never send outside [start,end) local hours. -----------------
  if (!withinSendWindow(now, window)) {
    return { kind: "outside_window", clientId, campaignId, window: sendWindowLabel(window) };
  }

  // ---- Concurrent-run guard + driver-OWN-run continuation. ---------------------------
  const active = await getActiveCampaignRun(clientId, campaignId);
  const ownsActive = active !== null && (adoptActiveRun || requestedRunId === active.id);

  // ---- Lead-target auto-pause (V6): deliver-then-stop. A business gate ON TOP of -----
  // suppression/eligibility, NEVER a relaxation. Read fresh each batch so hitting Run can't
  // over-send. A target met halts THIS client only; it never touches eligibility.
  const targetStatus = await getTargetStatus(client, now);
  if (targetStatus.met) {
    // If this caller owns the active run, close it so it doesn't linger open blocking the resume.
    if (active && ownsActive) {
      await finishCampaignRun(
        clientId,
        active.id,
        0,
        `paused: target met (${targetStatus.leadsThisPeriod}/${targetStatus.target} this ${targetStatus.period})`
      );
    }
    return {
      kind: "target_met",
      clientId,
      campaignId,
      target: targetStatus.target,
      period: targetStatus.period,
      leadsThisPeriod: targetStatus.leadsThisPeriod,
      nextPeriod: targetStatus.nextPeriod,
      message: `Target met (${targetStatus.leadsThisPeriod}/${targetStatus.target} this ${targetStatus.period}) — paused until ${targetStatus.nextPeriod}`,
    };
  }

  const eligible = await getEligibleContacts(clientId, { campaignId, limit });

  let runId: number;
  if (active) {
    if (ownsActive) {
      runId = active.id; // continuing / adopting the active run — allowed
    } else {
      // A different operator's run is active and we don't own/adopt it: block, handing back its id.
      return { kind: "already_running", runId: active.id };
    }
  } else {
    // No active run → start fresh (also the resume-after-expiry path).
    if (eligible.length === 0) {
      await setCampaignAutoSend(clientId, campaignId, false); // nothing to send → stop driving it
      return { kind: "drained", clientId, campaignId };
    }
    runId = await createCampaignRun(clientId, campaignId, eligible.length, note);
  }

  // Continuing an OWN/adopted run with nothing left to send → close it out (drained).
  if (eligible.length === 0) {
    await finishCampaignRun(clientId, runId, 0, note ?? "drained (nothing eligible)");
    await setCampaignAutoSend(clientId, campaignId, false);
    return { kind: "drained", clientId, campaignId, runId };
  }

  // ---- Paced send of THIS batch. The run is now OPEN; the finally closes it if we throw. ----
  const delay = pacingDelayMs(client.send_rate_per_hour);
  let runClosed = false;
  try {
    const result = await runSend(client, eligible, variants, delay);

    // Are there still eligible contacts after this batch? (Cheap indexed probe — same predicate.)
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
      // Stop driving the campaign ONLY on a genuine drain. A window stop leaves auto_send ON so the
      // cron resumes it when the window reopens (a target pause already returned above).
      if (!result.stoppedForWindow) await setCampaignAutoSend(clientId, campaignId, false);
    } else {
      await touchCampaignRun(clientId, runId, result.sent);
    }
    runClosed = true;

    return {
      kind: "sent",
      clientId,
      campaignId,
      runId,
      done,
      eligible: eligible.length,
      attempted: result.attempted,
      sent: result.sent,
      failed: result.failed,
      skippedOverflow: result.skippedOverflow,
      skippedClaimed: result.skippedClaimed,
      stoppedForWindow: result.stoppedForWindow,
      perVariant: result.perVariant,
      ratePerHour: sendRatePerHour(client.send_rate_per_hour),
    };
  } finally {
    // Only fires when the try threw before finalizing — close the run so it can't strand open.
    if (!runClosed) {
      await finishCampaignRun(clientId, runId, 0, "aborted (exception during send batch)").catch(
        () => {}
      );
    }
  }
}

/**
 * Walk the eligible list, claim each contact atomically, render, enforce the segment cap, send, and
 * record state — pacing between sends. Returns a tally. (Moved verbatim from the campaign route.)
 *
 * The send window is re-checked every iteration so a run that begins late never texts past the
 * window's close. The A/B variant is assigned by `attemptIndex` (advanced only for contacts we
 * actually send) so the realized split stays balanced even when some rows are skipped.
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
