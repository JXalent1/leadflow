import { neon } from "@neondatabase/serverless";

// Single source of truth for the DB connection. Neon via the Vercel integration.
// Use the tagged-template `sql` helper for queries; reach for Pool/WebSocket mode
// only if a real multi-statement transaction is ever needed (none yet).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy it from Neon into .env.local.");
}

export const sql = neon(connectionString);

// ---- Types -----------------------------------------------------------------

export interface Contact {
  id: number;
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

// ---- Helpers ---------------------------------------------------------------
// Signatures are stable so later sessions wire to them without renaming.
// Some bodies are stubs until their owning session (noted inline).

/**
 * Contacts eligible to be texted. (Session 3 — the single, load-bearing send gate.)
 *
 * Eligibility = phone present AND not suppressed (DNC/litigator/opt-out/no-match)
 * AND scrub_status='clean' (the scrub actually ran and passed — a matched-but-not-yet-
 * scrubbed contact is 'pending' and therefore NOT eligible) AND not already sent.
 * This is the only query that decides who can be texted — never relax it.
 */
export async function getEligibleContacts(limit?: number): Promise<Contact[]> {
  const rows = limit
    ? await sql`
        SELECT * FROM contacts
        WHERE phone IS NOT NULL
          AND suppressed = false
          AND scrub_status = 'clean'
          AND send_status = 'not_sent'
        ORDER BY id
        LIMIT ${limit}
      `
    : await sql`
        SELECT * FROM contacts
        WHERE phone IS NOT NULL
          AND suppressed = false
          AND scrub_status = 'clean'
          AND send_status = 'not_sent'
        ORDER BY id
      `;
  return rows as Contact[];
}

/**
 * Mark a contact's scrub verdict. (Session 3) 'clean' = scrub ran and passed (eligible);
 * 'flagged' = any DNC/litigator flag, suppression, or fail-closed error (never eligible).
 */
export async function setScrubStatus(id: number, status: "clean" | "flagged"): Promise<void> {
  await sql`
    UPDATE contacts
    SET scrub_status = ${status}
    WHERE id = ${id}
  `;
}

/**
 * Atomically claim a contact for sending. (Session 3 — idempotency / no-double-text.)
 * Conditionally flips not_sent -> sending in a single statement so a crash or a concurrent
 * re-run can never select the same contact twice. Returns true only if THIS call won the row.
 */
export async function claimForSend(id: number): Promise<boolean> {
  const rows = await sql`
    UPDATE contacts
    SET send_status = 'sending'
    WHERE id = ${id} AND send_status = 'not_sent'
    RETURNING id
  `;
  return rows.length > 0;
}

/** Record the assigned A/B variant for a contact. (Session 3) */
export async function setVariant(id: number, variant: string): Promise<void> {
  await sql`
    UPDATE contacts
    SET variant = ${variant}
    WHERE id = ${id}
  `;
}

/** Set a contact's terminal send state after an attempt. (Session 3) */
export async function setSendStatus(
  id: number,
  status: "sent" | "failed" | "not_sent"
): Promise<void> {
  await sql`
    UPDATE contacts
    SET send_status = ${status}
    WHERE id = ${id}
  `;
}

/** Open a campaign run row; returns its id. (Session 3) */
export async function createCampaignRun(totalEligible: number, note?: string): Promise<number> {
  const rows = await sql`
    INSERT INTO campaign_runs (total_eligible, note)
    VALUES (${totalEligible}, ${note ?? null})
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/** Update a campaign run's sent tally / note and stamp finished_at when the batch ends. (Session 3) */
export async function finishCampaignRun(id: number, sentCount: number, note?: string): Promise<void> {
  await sql`
    UPDATE campaign_runs
    SET sent_count = ${sentCount}, note = ${note ?? null}, finished_at = now()
    WHERE id = ${id}
  `;
}

/**
 * Is a campaign run currently in flight? (Session 3 review — concurrent-run guard.)
 * A run is "active" if finished_at IS NULL and it started within `withinMinutes`
 * (default 6, just above the 5-min function maxDuration) — older unfinished rows are
 * treated as dead (the function timed out without stamping finished_at) so a crash
 * never blocks future runs forever. Not a perfect mutex (the HTTP driver is stateless,
 * so two near-simultaneous POSTs can both pass) — the atomic per-contact claim is the
 * real no-double-text guarantee; this just stops casual concurrent runs from defeating pacing.
 */
export async function hasActiveCampaignRun(withinMinutes = 6): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM campaign_runs
    WHERE finished_at IS NULL
      AND started_at > now() - make_interval(mins => ${withinMinutes})
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Send-path progress for the GET endpoint + dashboard. (Session 3) */
export async function getSendProgress(): Promise<{
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
      COUNT(*) FILTER (
        WHERE phone IS NOT NULL AND suppressed = false
          AND scrub_status = 'clean' AND send_status = 'not_sent'
      )::int                                                          AS eligible,
      COUNT(*) FILTER (WHERE send_status = 'sent')::int               AS sent,
      -- pending = sendable backlog (mirrors the eligibility predicate exactly).
      COUNT(*) FILTER (
        WHERE phone IS NOT NULL AND suppressed = false
          AND scrub_status = 'clean' AND send_status = 'not_sent'
      )::int                                                          AS pending,
      -- in_flight = rows claimed but not yet finalized; a stuck count here means a
      -- run died mid-send (manual inspection — do NOT auto-reset, see campaign route).
      COUNT(*) FILTER (WHERE send_status = 'sending')::int            AS in_flight,
      COUNT(*) FILTER (WHERE send_status = 'failed')::int             AS failed,
      COUNT(*) FILTER (WHERE suppressed = true)::int                  AS suppressed
    FROM contacts
  `;
  const r = rows[0] as {
    eligible: number;
    sent: number;
    pending: number;
    in_flight: number;
    failed: number;
    suppressed: number;
  };
  const optRows = await sql`SELECT COUNT(*)::int AS opted_out FROM opt_outs`;
  const opted_out = (optRows[0] as { opted_out: number }).opted_out;
  return { ...r, opted_out };
}

/** Insert one contact. Returns the new id. Used by the CSV importer (Session 1). */
export async function insertContact(c: NewContact): Promise<number> {
  const rows = await sql`
    INSERT INTO contacts (first_name, last_name, address, city, state, zip)
    VALUES (${c.first_name}, ${c.last_name}, ${c.address}, ${c.city}, ${c.state}, ${c.zip})
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/** Flag a contact as suppressed with a reason. (Sessions 2 & 4) */
export async function markSuppressed(id: number, reason: string): Promise<void> {
  await sql`
    UPDATE contacts
    SET suppressed = true, suppress_reason = ${reason}
    WHERE id = ${id}
  `;
}

/** Contacts still needing a skip trace. Idempotency hinges on this filter. (Session 2) */
export async function getContactsForSkiptrace(limit?: number): Promise<Contact[]> {
  const rows = limit
    ? await sql`
        SELECT * FROM contacts
        WHERE skiptrace_status = 'pending'
        ORDER BY id
        LIMIT ${limit}
      `
    : await sql`
        SELECT * FROM contacts
        WHERE skiptrace_status = 'pending'
        ORDER BY id
      `;
  return rows as Contact[];
}

/** Matched contacts with a phone that have not yet been suppressed. (Session 2 scrub) */
export async function getContactsForScrub(limit?: number): Promise<Contact[]> {
  const rows = limit
    ? await sql`
        SELECT * FROM contacts
        WHERE skiptrace_status = 'matched'
          AND phone IS NOT NULL
          AND suppressed = false
        ORDER BY id
        LIMIT ${limit}
      `
    : await sql`
        SELECT * FROM contacts
        WHERE skiptrace_status = 'matched'
          AND phone IS NOT NULL
          AND suppressed = false
        ORDER BY id
      `;
  return rows as Contact[];
}

/**
 * Write a skip-trace result back to a contact. Additive helper for Session 2.
 * A no-match writes phone null + status 'no_match'; the route also suppresses it.
 */
export async function setTraceResult(
  id: number,
  result: { phone: string | null; phoneType: string | null; status: "matched" | "no_match" }
): Promise<void> {
  await sql`
    UPDATE contacts
    SET phone = ${result.phone},
        phone_type = ${result.phoneType},
        skiptrace_status = ${result.status}
    WHERE id = ${id}
  `;
}

/** Log an outbound or inbound message. (Sessions 3 & 4) */
// contactId is nullable so an orphan inbound / its confirmation can still be logged.
export async function recordMessage(args: {
  contactId: number | null;
  direction: MessageDirection;
  body: string;
  twilioSid?: string | null;
  status?: string | null;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO messages (contact_id, direction, body, twilio_sid, status)
    VALUES (${args.contactId}, ${args.direction}, ${args.body},
            ${args.twilioSid ?? null}, ${args.status ?? null})
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/**
 * Log an INBOUND message exactly once, keyed on twilio_sid. (Session 4 — idempotency.)
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING against the partial unique index on
 * messages(twilio_sid) so a Twilio webhook retry (same MessageSid) is a no-op.
 * Returns the new message id, or null if this SID was already logged — the webhook
 * treats null as "duplicate, stop" so no opt-out / lead / forward is double-applied.
 */
export async function logInboundOnce(args: {
  contactId: number | null;
  body: string;
  twilioSid: string;
}): Promise<number | null> {
  const rows = await sql`
    INSERT INTO messages (contact_id, direction, body, twilio_sid)
    VALUES (${args.contactId}, 'inbound', ${args.body}, ${args.twilioSid})
    ON CONFLICT (twilio_sid) WHERE twilio_sid IS NOT NULL DO NOTHING
    RETURNING id
  `;
  return rows.length ? (rows[0] as { id: number }).id : null;
}

/**
 * Find a contact by inbound sender phone. (Session 4.) The argument is the
 * normalized last-10 digits (normalizePhone); we compare against the stored phone
 * reduced to its last 10 digits too, so formatting differences never miss a match.
 */
export async function findContactByPhone(phone: string): Promise<Contact | null> {
  if (!phone) return null;
  // NOTE: '[^0-9]', not '\D'. A JS template literal cooks '\D' down to 'D' (the backslash is
  // dropped for unrecognized escapes) and neon's sql tag sends the cooked text, so '\D' would
  // strip literal 'D's instead of non-digits. '[^0-9]' has no backslash and is unambiguous in
  // Postgres. (Today stored phones are already last-10 digits, but this keeps the match honest.)
  const rows = await sql`
    SELECT * FROM contacts
    WHERE phone IS NOT NULL
      AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${phone}
    ORDER BY id
    LIMIT 1
  `;
  return rows.length ? (rows[0] as Contact) : null;
}

/**
 * Record a STOP/unsubscribe event. (Session 4.) contactId may be null for an
 * opt-out from a number we have no contact row for — we still keep the phone on
 * permanent record. The caller also sets contacts.suppressed when a contact matched.
 */
export async function recordOptOut(contactId: number | null, phone: string): Promise<void> {
  // Idempotent on phone (ON CONFLICT against the unique index) so a Twilio retry's
  // suppression-recovery path (see lib/inbound.ts) never writes a duplicate opt-out row.
  await sql`
    INSERT INTO opt_outs (contact_id, phone)
    VALUES (${contactId}, ${phone})
    ON CONFLICT (phone) DO NOTHING
  `;
}

/** Mark a lead as forwarded to Talan (the SMS ping succeeded). (Session 4.) */
export async function markLeadForwarded(leadId: number): Promise<void> {
  await sql`
    UPDATE leads
    SET forwarded = true, forwarded_at = now()
    WHERE id = ${leadId}
  `;
}

/** Create a lead from an interested reply. (Session 4) */
export async function createLead(args: {
  contactId: number;
  replyText: string;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO leads (contact_id, reply_text)
    VALUES (${args.contactId}, ${args.replyText})
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/** Dashboard counts for the admin stub. (Session 1) */
export async function getContactCounts(): Promise<{
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
  `;
  const r = rows[0] as { total: number; with_phone: number; suppressed: number };
  return { total: r.total, withPhone: r.with_phone, suppressed: r.suppressed };
}

// ---------------------------------------------------------------------------
// Dashboard read helpers (Session 5 — Module 5). READ-ONLY: every query below
// is a SELECT. No mutation logic lives here; the dashboard's buttons call the
// existing /api/{skiptrace,scrub,campaign} endpoints for any write.
// ---------------------------------------------------------------------------

/** A lead joined to its contact, for the dashboard's primary leads table. */
export interface LeadRow {
  id: number;
  contact_id: number | null;
  first_name: string | null;
  last_name: string | null;
  address: string | null;
  phone: string | null;
  reply_text: string | null;
  forwarded: boolean;
  forwarded_at: string | null;
  status: string;
  created_at: string;
}

/** An inbound message joined to its contact, for the reply feed. */
export interface InboundRow {
  id: number;
  contact_id: number | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  body: string;
  created_at: string;
}

/** An opt-out joined to its contact (if any), for the opt-out list. */
export interface OptOutRow {
  id: number;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
}

/** Extra count cards not covered by getContactCounts/getSendProgress. */
export async function getDashboardExtraCounts(): Promise<{
  scrubbedClean: number;
  leads: number;
}> {
  const rows = await sql`
    SELECT
      (SELECT COUNT(*) FROM contacts WHERE scrub_status = 'clean')::int AS scrubbed_clean,
      (SELECT COUNT(*) FROM leads)::int                                 AS leads
  `;
  const r = rows[0] as { scrubbed_clean: number; leads: number };
  return { scrubbedClean: r.scrubbed_clean, leads: r.leads };
}

/** Most-recent leads joined to their contact (name, address, phone). Newest first. */
export async function getRecentLeads(limit = 50): Promise<LeadRow[]> {
  const rows = await sql`
    SELECT
      l.id, l.contact_id, l.reply_text, l.forwarded, l.forwarded_at, l.status, l.created_at,
      c.first_name, c.last_name, c.address, c.phone
    FROM leads l
    LEFT JOIN contacts c ON c.id = l.contact_id
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit}
  `;
  return rows as LeadRow[];
}

/** Most-recent inbound messages joined to their contact. Newest first. */
export async function getRecentInbound(limit = 50): Promise<InboundRow[]> {
  const rows = await sql`
    SELECT
      m.id, m.contact_id, m.body, m.created_at,
      c.first_name, c.last_name, c.phone
    FROM messages m
    LEFT JOIN contacts c ON c.id = m.contact_id
    WHERE m.direction = 'inbound'
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit}
  `;
  return rows as InboundRow[];
}

/** Most-recent opt-outs joined to their contact (if matched). Newest first. */
export async function getRecentOptOuts(limit = 50): Promise<OptOutRow[]> {
  const rows = await sql`
    SELECT
      o.id, o.phone, o.created_at,
      c.first_name, c.last_name
    FROM opt_outs o
    LEFT JOIN contacts c ON c.id = o.contact_id
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${limit}
  `;
  return rows as OptOutRow[];
}
