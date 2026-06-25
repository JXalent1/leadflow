import "server-only";
import { neon } from "@neondatabase/serverless";

// Single source of truth for the DB connection. Neon via the Vercel integration.
// Use the tagged-template `sql` helper for queries; reach for Pool/WebSocket mode
// only if a real multi-statement transaction is ever needed (none yet).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy it from Neon into .env.local.");
}

export const sql = neon(connectionString);

// ---- Multi-tenant (v2 Module V1) -------------------------------------------
// EVERY helper below takes a clientId and scopes its query by client_id — in the WHERE
// for reads/updates and as a column on every INSERT. No query may read or write across
// clients. The clientId is resolved per request (operator default = client 1; inbound
// webhook = the client owning the To number) and threaded down from the caller.

// ---- Types -----------------------------------------------------------------

export interface Contact {
  id: number;
  client_id: number;
  campaign_id: number;
  first_name: string | null;
  last_name: string | null;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  phone_type: string | null;
  suppressed: boolean;
  suppress_reason: string | null;
  skiptrace_status: string;
  scrub_status: string;
  send_status: string;
  variant: string | null;
  created_at: string;
}

export interface NewContact {
  first_name: string | null;
  last_name: string | null;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export type MessageDirection = "outbound" | "inbound";

/**
 * Scope for a contact selection (v2 Module V2): which campaign (omit = all the client's
 * campaigns) and an optional row cap. A null/omitted campaignId selects across the client.
 */
export interface ContactScope {
  campaignId?: number;
  limit?: number;
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Contacts eligible to be texted, for ONE client (optionally ONE campaign). (Session 3 — the
 * single send gate; extended in v2 Module V2 with campaign scope + client-level suppression.)
 *
 * Eligibility = same client (and campaign, if scoped) AND phone present AND not suppressed AND
 * scrub_status='clean' (the scrub ran and passed — a matched-but-unscrubbed contact is 'pending'
 * → NOT eligible) AND not already sent AND the phone is NOT in this client's opt_outs.
 *
 * The opt_outs exclusion is LOAD-BEARING and CLIENT-level (not campaign-level): a person who
 * opted out under ANY of the client's campaigns is excluded from EVERY campaign, current and
 * future — even a brand-new contact row in a new campaign with the same number. We compare on
 * the last-10 digits (same normalization as findContactByPhone) so formatting never misses a
 * suppression. Never relax this query, never drop the client_id scope, never make the opt_out
 * check campaign-scoped.
 */
export async function getEligibleContacts(
  clientId: number,
  scope: ContactScope = {}
): Promise<Contact[]> {
  const { campaignId, limit } = scope;
  const rows = await sql`
    SELECT * FROM contacts c
    WHERE c.client_id = ${clientId}
      AND (${campaignId ?? null}::int IS NULL OR c.campaign_id = ${campaignId ?? null}::int)
      AND c.phone IS NOT NULL
      AND c.suppressed = false
      AND c.scrub_status = 'clean'
      AND c.send_status = 'not_sent'
      AND NOT EXISTS (
        SELECT 1 FROM opt_outs o
        WHERE o.client_id = ${clientId}
          AND right(regexp_replace(o.phone, '[^0-9]', '', 'g'), 10)
            = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
      )
    ORDER BY c.id
    LIMIT ${limit ?? null}
  `;
  return rows as Contact[];
}

/**
 * Mark a contact's scrub verdict. (Session 3) 'clean' = scrub ran and passed (eligible);
 * 'flagged' = any DNC/litigator flag, suppression, or fail-closed error (never eligible).
 */
export async function setScrubStatus(
  clientId: number,
  id: number,
  status: "clean" | "flagged"
): Promise<void> {
  await sql`UPDATE contacts SET scrub_status = ${status} WHERE id = ${id} AND client_id = ${clientId}`;
}

/**
 * Atomically claim a contact for sending. (Session 3 — idempotency / no-double-text.)
 * Conditionally flips not_sent -> sending in a single statement so a crash or a concurrent
 * re-run can never select the same contact twice. Returns true only if THIS call won the row.
 *
 * Defense-in-depth (v2 V2 review): the claim ALSO re-checks the client's opt_outs (same
 * client-level last-10-digit predicate as getEligibleContacts), so even if a STOP arrives in the
 * race window between getEligibleContacts and this claim mid-run, the row won't be claimed and the
 * contact is never texted. The eligibility query is the primary gate; this closes the TOCTOU race.
 */
export async function claimForSend(clientId: number, id: number): Promise<boolean> {
  const rows = await sql`
    UPDATE contacts
    SET send_status = 'sending'
    WHERE id = ${id} AND client_id = ${clientId} AND send_status = 'not_sent'
      AND NOT EXISTS (
        SELECT 1 FROM opt_outs o
        WHERE o.client_id = contacts.client_id
          AND right(regexp_replace(o.phone, '[^0-9]', '', 'g'), 10)
            = right(regexp_replace(contacts.phone, '[^0-9]', '', 'g'), 10)
      )
    RETURNING id
  `;
  return rows.length > 0;
}

/** Record the assigned A/B variant for a contact. (Session 3) */
export async function setVariant(clientId: number, id: number, variant: string): Promise<void> {
  await sql`UPDATE contacts SET variant = ${variant} WHERE id = ${id} AND client_id = ${clientId}`;
}

/** Set a contact's terminal send state after an attempt. (Session 3) */
export async function setSendStatus(
  clientId: number,
  id: number,
  status: "sent" | "failed" | "not_sent"
): Promise<void> {
  await sql`UPDATE contacts SET send_status = ${status} WHERE id = ${id} AND client_id = ${clientId}`;
}

/**
 * Send-path progress for one client, optionally scoped to one campaign. (Session 3; campaign
 * scope + client-level opt_out exclusion added v2 Module V2.) The eligible/pending counts mirror
 * getEligibleContacts EXACTLY — same predicate including the client-level opt_outs exclusion — so
 * the dashboard's "eligible" never overcounts a person the client has opted out. opted_out is the
 * client's whole opt-out list (it is suppression-by-phone across all campaigns, not per-campaign).
 */
export async function getSendProgress(
  clientId: number,
  campaignId?: number
): Promise<{
  eligible: number;
  sent: number;
  pending: number;
  in_flight: number;
  failed: number;
  suppressed: number;
  opted_out: number;
}> {
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE is_eligible)::int                AS eligible,
      COUNT(*) FILTER (WHERE send_status = 'sent')::int       AS sent,
      COUNT(*) FILTER (WHERE is_eligible)::int                AS pending,
      -- in_flight = rows claimed but not yet finalized; a stuck count here means a
      -- run died mid-send (manual inspection — do NOT auto-reset, see campaign route).
      COUNT(*) FILTER (WHERE send_status = 'sending')::int    AS in_flight,
      COUNT(*) FILTER (WHERE send_status = 'failed')::int     AS failed,
      COUNT(*) FILTER (WHERE suppressed = true)::int          AS suppressed
    FROM (
      SELECT
        c.send_status,
        c.suppressed,
        (c.phone IS NOT NULL AND c.suppressed = false AND c.scrub_status = 'clean'
           AND c.send_status = 'not_sent'
           AND NOT EXISTS (
             SELECT 1 FROM opt_outs o
             WHERE o.client_id = c.client_id
               AND right(regexp_replace(o.phone, '[^0-9]', '', 'g'), 10)
                 = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
           )) AS is_eligible
      FROM contacts c
      WHERE c.client_id = ${clientId}
        AND (${campaignId ?? null}::int IS NULL OR c.campaign_id = ${campaignId ?? null}::int)
    ) t
  `;
  const r = rows[0] as {
    eligible: number;
    sent: number;
    pending: number;
    in_flight: number;
    failed: number;
    suppressed: number;
  };
  const optRows = await sql`SELECT COUNT(*)::int AS opted_out FROM opt_outs WHERE client_id = ${clientId}`;
  const opted_out = (optRows[0] as { opted_out: number }).opted_out;
  return { ...r, opted_out };
}

/**
 * Insert one contact for a client + campaign. Returns the new id. (CSV importer / uploader.)
 * campaign_id is required (the column has no default — a forgotten campaign_id fails loudly).
 */
export async function insertContact(
  clientId: number,
  campaignId: number,
  c: NewContact
): Promise<number> {
  const rows = await sql`
    INSERT INTO contacts (client_id, campaign_id, first_name, last_name, address, city, state, zip)
    VALUES (${clientId}, ${campaignId}, ${c.first_name}, ${c.last_name}, ${c.address}, ${c.city}, ${c.state}, ${c.zip})
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/** Flag a contact as suppressed with a reason. (Sessions 2 & 4) */
export async function markSuppressed(clientId: number, id: number, reason: string): Promise<void> {
  await sql`
    UPDATE contacts
    SET suppressed = true, suppress_reason = ${reason}
    WHERE id = ${id} AND client_id = ${clientId}
  `;
}

/**
 * Contacts still needing a skip trace, for a client (optionally one campaign). Idempotency hinges
 * on the skiptrace_status='pending' filter. (Session 2; campaign scope v2 V2.)
 */
export async function getContactsForSkiptrace(
  clientId: number,
  scope: ContactScope = {}
): Promise<Contact[]> {
  const { campaignId, limit } = scope;
  const rows = await sql`
    SELECT * FROM contacts
    WHERE client_id = ${clientId}
      AND (${campaignId ?? null}::int IS NULL OR campaign_id = ${campaignId ?? null}::int)
      AND skiptrace_status = 'pending'
    ORDER BY id
    LIMIT ${limit ?? null}
  `;
  return rows as Contact[];
}

/**
 * Matched contacts with a phone that still need scrubbing, for a client. (Session 2 scrub.)
 * scrub_status='pending' is LOAD-BEARING for credit safety: a clean contact keeps
 * suppressed=false, so without this filter it would be re-selected + re-billed every chunk
 * (the 2026-06-23 re-billing bug). Already-scrubbed (clean OR flagged) rows are excluded.
 */
export async function getContactsForScrub(
  clientId: number,
  scope: ContactScope = {}
): Promise<Contact[]> {
  const { campaignId, limit } = scope;
  const rows = await sql`
    SELECT * FROM contacts
    WHERE client_id = ${clientId}
      AND (${campaignId ?? null}::int IS NULL OR campaign_id = ${campaignId ?? null}::int)
      AND skiptrace_status = 'matched'
      AND phone IS NOT NULL
      AND suppressed = false
      AND scrub_status = 'pending'
    ORDER BY id
    LIMIT ${limit ?? null}
  `;
  return rows as Contact[];
}

/**
 * Write a skip-trace result back to a contact. Additive helper for Session 2.
 * A no-match writes phone null + status 'no_match'; the route also suppresses it.
 */
export async function setTraceResult(
  clientId: number,
  id: number,
  result: { phone: string | null; phoneType: string | null; status: "matched" | "no_match" }
): Promise<void> {
  await sql`
    UPDATE contacts
    SET phone = ${result.phone},
        phone_type = ${result.phoneType},
        skiptrace_status = ${result.status}
    WHERE id = ${id} AND client_id = ${clientId}
  `;
}

/** Log an outbound or inbound message for a client. (Sessions 3 & 4) */
// contactId is nullable so an orphan inbound / its confirmation can still be logged.
export async function recordMessage(args: {
  clientId: number;
  contactId: number | null;
  direction: MessageDirection;
  body: string;
  twilioSid?: string | null;
  status?: string | null;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO messages (client_id, contact_id, direction, body, twilio_sid, status)
    VALUES (${args.clientId}, ${args.contactId}, ${args.direction}, ${args.body},
            ${args.twilioSid ?? null}, ${args.status ?? null})
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/**
 * Log an INBOUND message exactly once PER CLIENT, keyed on twilio_sid. (Session 4 — idempotency.)
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING against the per-client partial unique index on
 * messages(client_id, twilio_sid) so a Twilio webhook retry (same MessageSid) is a no-op within
 * the owning client. Returns the new message id, or null if this SID was already logged for this
 * client — the webhook treats null as "duplicate, stop" so no opt-out / lead / forward repeats.
 */
export async function logInboundOnce(args: {
  clientId: number;
  contactId: number | null;
  body: string;
  twilioSid: string;
}): Promise<number | null> {
  const rows = await sql`
    INSERT INTO messages (client_id, contact_id, direction, body, twilio_sid)
    VALUES (${args.clientId}, ${args.contactId}, 'inbound', ${args.body}, ${args.twilioSid})
    ON CONFLICT (client_id, twilio_sid) WHERE twilio_sid IS NOT NULL DO NOTHING
    RETURNING id
  `;
  return rows.length ? (rows[0] as { id: number }).id : null;
}

/**
 * Find a contact by inbound sender phone, WITHIN one client. (Session 4.) The argument is the
 * normalized last-10 digits (normalizePhone); we compare against the stored phone reduced to
 * its last 10 digits too, so formatting differences never miss a match. Scoped to client_id so
 * an inbound to client A's number can never match (and then suppress/forward) client B's contact.
 */
export async function findContactByPhone(clientId: number, phone: string): Promise<Contact | null> {
  if (!phone) return null;
  // NOTE: '[^0-9]', not '\D'. A JS template literal cooks '\D' down to 'D', so '[^0-9]' is used.
  const rows = await sql`
    SELECT * FROM contacts
    WHERE client_id = ${clientId}
      AND phone IS NOT NULL
      AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${phone}
    ORDER BY id
    LIMIT 1
  `;
  return rows.length ? (rows[0] as Contact) : null;
}

/**
 * Record a STOP/unsubscribe event for a client. (Session 4.) contactId may be null for an
 * opt-out from a number we have no contact row for — we still keep the phone on permanent
 * record. Idempotent on (client_id, phone) so a Twilio retry's recovery path never duplicates.
 */
export async function recordOptOut(
  clientId: number,
  contactId: number | null,
  phone: string
): Promise<void> {
  // Store the suppression key normalized to last-10 digits so the (client_id, phone) unique index
  // and the eligibility opt_outs match are on a canonical form. Callers already pass normalized
  // phones today; this makes the invariant hold regardless of caller (v2 V2 review, defense-in-depth).
  const normalized = phone.replace(/[^0-9]/g, "").slice(-10) || phone;
  await sql`
    INSERT INTO opt_outs (client_id, contact_id, phone)
    VALUES (${clientId}, ${contactId}, ${normalized})
    ON CONFLICT (client_id, phone) DO NOTHING
  `;
}

/** Mark a lead as forwarded to the client contact (the SMS ping succeeded). (Session 4.) */
export async function markLeadForwarded(clientId: number, leadId: number): Promise<void> {
  await sql`
    UPDATE leads
    SET forwarded = true, forwarded_at = now()
    WHERE id = ${leadId} AND client_id = ${clientId}
  `;
}

/** Create a lead from an interested reply, for a client. (Session 4) */
export async function createLead(args: {
  clientId: number;
  contactId: number;
  replyText: string;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO leads (client_id, contact_id, reply_text)
    VALUES (${args.clientId}, ${args.contactId}, ${args.replyText})
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/**
 * Count a client's leads created within a [startISO, endISO) window. (v2 Module V6 — the
 * deliver-then-stop gate.) Scoped to one client_id; the half-open window (start inclusive, end
 * exclusive) mirrors the cockpit/portal cycle counting so the auto-pause period is off-by-one safe.
 */
export async function countLeadsInPeriod(
  clientId: number,
  startISO: string,
  endISO: string
): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM leads
    WHERE client_id = ${clientId} AND created_at >= ${startISO} AND created_at < ${endISO}
  `;
  return (rows[0] as { n: number }).n;
}

/** Dashboard counts for one client (optionally one campaign). (Session 1; campaign scope v2 V2) */
export async function getContactCounts(
  clientId: number,
  campaignId?: number
): Promise<{
  total: number;
  withPhone: number;
  suppressed: number;
}> {
  const rows = await sql`
    SELECT
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE phone IS NOT NULL)::int         AS with_phone,
      COUNT(*) FILTER (WHERE suppressed = true)::int         AS suppressed
    FROM contacts
    WHERE client_id = ${clientId}
      AND (${campaignId ?? null}::int IS NULL OR campaign_id = ${campaignId ?? null}::int)
  `;
  const r = rows[0] as { total: number; with_phone: number; suppressed: number };
  return { total: r.total, withPhone: r.with_phone, suppressed: r.suppressed };
}
