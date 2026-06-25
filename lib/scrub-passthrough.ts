// lib/scrub-passthrough.ts — the no-scrub (scrub_mode='none') passthrough. (Module N, 2026-06-25)
//
// Some campaigns are sent WITHOUT a vendor DNC/litigator scrub — the operator pre-filters the list
// at the source. The send path makes a contact eligible only when scrub_status='clean' (set by the
// scrub stage), so a no-vendor-scrub campaign could never send. This passthrough satisfies that
// requirement WITHOUT any external call or credit spend: it marks the campaign's traced, with-phone,
// still-pending contacts clean in ONE scoped UPDATE.
//
// LOAD-BEARING: this touches scrub_status ONLY. It does NOT touch opt-out/suppression logic — the
// eligibility query (getEligibleContacts) and claimForSend still independently exclude any phone in
// the client's opt_outs and any suppressed=true contact, so an opted-out contact stays excluded even
// after passthrough marks it clean. The selection mirrors getContactsForScrub EXACTLY (matched +
// has-phone + not-suppressed + pending), minus the vendor call — so it never flips a suppressed row,
// and re-running is a no-op on already-clean rows (idempotent, no double-anything).

import "server-only";
import { sql } from "@/lib/db";

export interface PassthroughScrubResult {
  scrubbed: number; // rows moved pending -> clean this batch (0 when drained — the driver's stop signal)
  clean: number; // same as scrubbed (passthrough never suppresses)
  suppressed: number; // always 0 — no vendor verdicts, nothing flagged
  note: string;
}

/**
 * No-scrub passthrough: mark up to `limit` of the campaign's matched, with-phone, still-pending
 * contacts scrub_status='clean' (all if `limit` omitted). NO getCredits, NO submitScrub, NO
 * scrub_jobs row. Scoped to (clientId, campaignId). Returns the count touched so the pipeline driver
 * can loop the scrub stage until it drains exactly as it does for the vendor path.
 */
export async function passthroughScrubBatch(
  clientId: number,
  scope: { campaignId?: number; limit?: number } = {}
): Promise<PassthroughScrubResult> {
  const { campaignId, limit } = scope;
  // UPDATE ... WHERE id IN (SELECT ... LIMIT) — Postgres has no UPDATE ... LIMIT. The inner SELECT
  // mirrors getContactsForScrub's predicate byte-for-byte (minus the vendor call). RETURNING counts.
  const rows = await sql`
    UPDATE contacts SET scrub_status = 'clean'
    WHERE id IN (
      SELECT id FROM contacts
      WHERE client_id = ${clientId}
        AND (${campaignId ?? null}::int IS NULL OR campaign_id = ${campaignId ?? null}::int)
        AND skiptrace_status = 'matched'
        AND phone IS NOT NULL
        AND suppressed = false
        AND scrub_status = 'pending'
      ORDER BY id
      LIMIT ${limit ?? null}
    )
    RETURNING id
  `;
  const scrubbed = rows.length;
  return {
    scrubbed,
    clean: scrubbed,
    suppressed: 0,
    note:
      scrubbed > 0
        ? "no-scrub passthrough: marked clean without a vendor call"
        : "no-scrub passthrough: nothing pending to mark",
  };
}
