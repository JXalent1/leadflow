/**
 * lib/followups.ts — DB layer for follow-up / re-engagement campaigns. (Build: followup-campaigns)
 *
 * Re-text a prior campaign's NON-RESPONDERS with a new short message, REUSING their already-traced +
 * already-clean phones. This is the biggest margin lever (no re-trace, no re-scrub, no vendor spend):
 *   - getFollowupAudienceIds / getFollowupAudienceCount — gather the per-contact FACTS for the source
 *     campaign in ONE query, then apply the PURE rule in lib/followup-audience.ts (single source of
 *     truth — no eligibility logic is re-decided in SQL here).
 *   - createFollowupCampaign — create a follow-up campaign (source_campaign_id set, scrub_mode='none')
 *     and SEED its contacts by COPYING the source contact's phone straight to send-ready
 *     (skiptrace_status='matched', scrub_status='clean', send_status='not_sent'). It calls NO Tracerfy
 *     and NO scrub vendor and writes NO trace_jobs/scrub_jobs — zero credits spent.
 *
 * The follow-up SEND then reuses the EXISTING send path entirely: the seeded rows are ordinary
 * not_sent / clean / matched contacts in a new campaign, so getEligibleContacts + claimForSend + the
 * send-window + the segment cap all apply unchanged. For a follow-up campaign the send route passes
 * followUp=true, so getEligibleContacts/claimForSend ALSO re-check opt-out + replied + lead EVERY
 * batch (client-level, last-10) — a STOP, a reply, OR a new lead landing between seeding and sending
 * all keep the contact from being texted. The audience filter is the first gate, the claim is the last.
 *
 * Concurrency: createFollowupCampaign stamps followup_round (Nth follow-up to this source) and the
 * partial unique index on (client_id, source_campaign_id, followup_round) makes two simultaneous
 * creates collide — the loser's INSERT throws before seeding, so the same phone can't be double-seeded.
 *
 * Every query is scoped by client_id; the source campaign's ownership is validated by the route
 * (getCampaignForClient) before any of this runs.
 */

import "server-only";
import { sql } from "@/lib/db";
import {
  clampMaxFollowups,
  selectFollowupAudience,
  type FollowupCandidate,
} from "@/lib/followup-audience";

/**
 * The default follow-up message body. The per-client opt-out line (e.g. `Reply "2" to opt out` for
 * Talan, or `Reply STOP to opt out`) is appended by renderMessage at send time — do NOT bake an
 * opt-out line in here or a STOP-only client would get a doubled line. Kept within the segment cap.
 */
export const DEFAULT_FOLLOWUP_TEMPLATE =
  "Hi [NAME], just following up — we're running great deals right now. Let me know if you're " +
  "interested in pressure washing, paver sealing, window cleaning, or whole-house exterior cleaning.";

export interface CreateFollowupResult {
  campaignId: number;
  seeded: number;
}

/** Coerce neon's boolean-ish return ('t'/'true'/true) to a JS boolean. */
function asBool(v: unknown): boolean {
  return v === true || v === "t" || v === "true";
}

/**
 * Fetch the source campaign's contacts WITH the derived audience facts, then apply the pure rule and
 * return the ids of the follow-up audience. ONE query computes, per source contact:
 *   replied         — EXISTS an inbound message from that phone (client-level, last-10)
 *   is_lead         — EXISTS a lead for that phone (client-level, last-10)
 *   opted_out       — EXISTS an opt_out for that phone (client-level, last-10; IDENTICAL to eligibility)
 *   prior_followups — how many follow-up campaigns of this client already include that phone
 * The selection itself (was_sent + phone + !suppressed + !replied + !is_lead + !opted_out +
 * prior_followups<max) is the PURE selectFollowupAudience — never re-implemented in SQL.
 */
export async function getFollowupAudienceIds(
  clientId: number,
  sourceCampaignId: number,
  maxFollowups?: number
): Promise<number[]> {
  const max = clampMaxFollowups(maxFollowups);
  const rows = (await sql`
    SELECT
      c.id,
      c.phone,
      (c.send_status = 'sent')                                  AS was_sent,
      c.suppressed                                             AS suppressed,
      EXISTS (
        SELECT 1 FROM messages m
        JOIN contacts mc ON mc.id = m.contact_id
        WHERE m.client_id = c.client_id
          AND m.direction = 'inbound'
          AND mc.phone IS NOT NULL
          AND right(regexp_replace(mc.phone, '[^0-9]', '', 'g'), 10)
            = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
      )                                                        AS replied,
      EXISTS (
        SELECT 1 FROM leads l
        JOIN contacts lc ON lc.id = l.contact_id
        WHERE l.client_id = c.client_id
          AND lc.phone IS NOT NULL
          AND right(regexp_replace(lc.phone, '[^0-9]', '', 'g'), 10)
            = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
      )                                                        AS is_lead,
      EXISTS (
        SELECT 1 FROM opt_outs o
        WHERE o.client_id = c.client_id
          AND right(regexp_replace(o.phone, '[^0-9]', '', 'g'), 10)
            = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
      )                                                        AS opted_out,
      (
        SELECT count(DISTINCT fc.id)::int FROM campaigns fc
        JOIN contacts fct ON fct.campaign_id = fc.id
        WHERE fc.client_id = c.client_id
          AND fc.source_campaign_id IS NOT NULL
          AND fct.phone IS NOT NULL
          AND right(regexp_replace(fct.phone, '[^0-9]', '', 'g'), 10)
            = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
      )                                                        AS prior_followups
    FROM contacts c
    WHERE c.client_id = ${clientId}
      AND c.campaign_id = ${sourceCampaignId}
      AND c.phone IS NOT NULL
    ORDER BY c.id
  `) as Record<string, unknown>[];

  const candidates: FollowupCandidate[] = rows.map((r) => ({
    id: Number(r.id),
    phone: (r.phone as string | null) ?? null,
    was_sent: asBool(r.was_sent),
    suppressed: asBool(r.suppressed),
    replied: asBool(r.replied),
    is_lead: asBool(r.is_lead),
    opted_out: asBool(r.opted_out),
    prior_followups: Number(r.prior_followups ?? 0),
  }));

  return selectFollowupAudience(candidates, max).map((c) => c.id);
}

/** Count of the follow-up audience for a source campaign (the UI count before creating). */
export async function getFollowupAudienceCount(
  clientId: number,
  sourceCampaignId: number,
  maxFollowups?: number
): Promise<number> {
  return (await getFollowupAudienceIds(clientId, sourceCampaignId, maxFollowups)).length;
}

/**
 * Create a follow-up campaign from a source campaign's non-responders and SEED it — reusing the
 * existing phones, spending ZERO trace/scrub credits.
 *
 * Steps: (1) compute the audience ids (pure rule). (2) INSERT the follow-up campaign row with
 * source_campaign_id set + scrub_mode='none' (so even the pipeline's scrub stage is a no-op — the
 * seeded rows are already clean) + status 'ready'. (3) seed its contacts in ONE INSERT … SELECT that
 * COPIES first_name/last_name/address/city/state/zip/phone/phone_type from the source contacts and
 * sets skiptrace_status='matched', scrub_status='clean', send_status='not_sent', suppressed=false —
 * NO Tracerfy, NO scrub, NO jobs row.
 *
 * NOTE: returns even when the audience is empty (an empty follow-up campaign — harmless). The send
 * path's atomic claim re-checks opt-outs, so a STOP between this seed and the send still protects the
 * contact (the audience filter excluded opted-out phones already; this is the belt-and-suspenders).
 */
export async function createFollowupCampaign(
  clientId: number,
  sourceCampaignId: number,
  opts: { name?: string | null; messageTemplate?: string | null; maxFollowups?: number } = {}
): Promise<CreateFollowupResult> {
  const max = clampMaxFollowups(opts.maxFollowups);
  const ids = await getFollowupAudienceIds(clientId, sourceCampaignId, max);

  const name = opts.name?.trim() || `Follow-up — campaign ${sourceCampaignId}`;
  const template = opts.messageTemplate ?? DEFAULT_FOLLOWUP_TEMPLATE;

  // The next follow-up round number for this source (1, 2, …). The unique index on
  // (client_id, source_campaign_id, followup_round) is the real concurrency guard: if two creates
  // race they both compute the same round and the second INSERT fails (caught upstream) rather than
  // double-seeding the same phones. Sequential rounds (1 then 2 under a higher cap) stay distinct.
  const roundRow = (
    await sql`
      SELECT COALESCE(MAX(followup_round), 0) + 1 AS next
      FROM campaigns
      WHERE client_id = ${clientId} AND source_campaign_id = ${sourceCampaignId}
    `
  )[0] as { next: number };
  const round = Number(roundRow.next);

  const camp = (
    await sql`
      INSERT INTO campaigns (client_id, name, status, message_template, scrub_mode, source_campaign_id, followup_round)
      VALUES (${clientId}, ${name}, 'ready', ${template}, 'none', ${sourceCampaignId}, ${round})
      RETURNING id
    `
  )[0] as { id: number };
  const campaignId = camp.id;

  if (ids.length === 0) return { campaignId, seeded: 0 };

  // Seed by COPYING the source contacts' traced phones straight to send-ready. No external call.
  const seeded = (await sql`
    INSERT INTO contacts (
      client_id, campaign_id, first_name, last_name, address, city, state, zip,
      phone, phone_type, skiptrace_status, scrub_status, send_status, suppressed
    )
    SELECT
      ${clientId}, ${campaignId}, first_name, last_name, address, city, state, zip,
      phone, phone_type, 'matched', 'clean', 'not_sent', false
    FROM contacts
    WHERE client_id = ${clientId}
      AND id = ANY(${ids}::int[])
    RETURNING id
  `) as { id: number }[];

  return { campaignId, seeded: seeded.length };
}
