/**
 * lib/followup-audience.ts — the PURE follow-up audience rule. (Build: followup-campaigns)
 *
 * A follow-up / re-engagement campaign re-texts a prior campaign's NON-RESPONDERS, reusing their
 * already-traced + already-clean phones (no re-trace, no re-scrub). This module is the single source
 * of truth for WHO belongs in that audience: a pure, DB-free predicate so it is unit-testable and
 * can never drift from the compliance rule. lib/followups.ts gathers the per-contact FACTS (the
 * flags below) from the DB in one query and then applies THIS function — it never re-decides
 * eligibility in SQL, so there is no second copy of the rule to drift.
 *
 * A contact is in the follow-up audience IFF ALL hold:
 *   - was_sent          — it actually received the source campaign's text (send_status='sent');
 *   - phone present     — we reuse the existing phone (a no-phone row can't be texted);
 *   - NOT suppressed    — it wasn't flagged/suppressed;
 *   - NOT replied       — no inbound message from that phone (a responder is not a follow-up target);
 *   - NOT a lead        — it didn't become a lead;
 *   - NOT opted out     — the phone is not in the client's opt_outs (client-level, last-10 — IDENTICAL
 *                          to send eligibility; the send path re-checks this every batch too);
 *   - prior_followups < maxFollowups — the follow-up CAP. prior_followups counts how many follow-up
 *                          campaigns already include this phone, so once a phone has been followed up
 *                          it drops out of the next audience — this is also what makes re-running an
 *                          audience IDEMPOTENT (no duplicate texts).
 *
 * NOTE: never relax this rule to text an opted-out / responded / lead contact. These checks mirror the
 * send path: for a follow-up campaign getEligibleContacts/claimForSend re-check opt-out + replied + lead
 * EVERY batch (followUp=true), so a STOP/reply/lead landing between seeding and sending still drops the
 * contact. The audience is the first gate; the atomic claim is the last.
 */

/** Default maximum follow-up rounds per contact (the prompt allows 1–2; 1 is the conservative default). */
export const DEFAULT_MAX_FOLLOWUPS = 1;

/** Clamp an operator-supplied cap to a sane positive integer (default DEFAULT_MAX_FOLLOWUPS, ≤10). */
export function clampMaxFollowups(n?: number | null): number {
  if (n == null || !Number.isFinite(n)) return DEFAULT_MAX_FOLLOWUPS;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 10) return 10;
  return i;
}

/**
 * The per-contact FACTS the audience rule needs. lib/followups.ts builds these from one SQL query
 * over the source campaign's contacts; tests build them by hand.
 */
export interface FollowupCandidate {
  id: number;
  phone: string | null;
  /** The contact received the source campaign's text (send_status='sent'). */
  was_sent: boolean;
  suppressed: boolean;
  /** There is an inbound message from this phone (client-level, last-10). */
  replied: boolean;
  /** This phone is a lead (client-level, last-10). */
  is_lead: boolean;
  /** This phone is in the client's opt_outs (client-level, last-10). */
  opted_out: boolean;
  /** How many follow-up campaigns already include this phone (the cap is measured against this). */
  prior_followups: number;
}

/** The pure follow-up audience predicate. See the file header for the full rule. */
export function isFollowupEligible(
  c: FollowupCandidate,
  maxFollowups: number = DEFAULT_MAX_FOLLOWUPS
): boolean {
  if (!c.was_sent) return false;
  if (!c.phone || !c.phone.trim()) return false;
  if (c.suppressed) return false;
  if (c.replied) return false;
  if (c.is_lead) return false;
  if (c.opted_out) return false;
  if (!Number.isFinite(c.prior_followups) || c.prior_followups >= maxFollowups) return false;
  return true;
}

/** Filter candidate rows to exactly the follow-up audience (pure; preserves order). */
export function selectFollowupAudience<T extends FollowupCandidate>(
  rows: T[],
  maxFollowups: number = DEFAULT_MAX_FOLLOWUPS
): T[] {
  return rows.filter((r) => isFollowupEligible(r, maxFollowups));
}
