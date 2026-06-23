/**
 * lib/inbox-db.ts — Inbox / reply / lead-tracking DB helpers. (Session 7 — Module 7)
 *
 * Split out of lib/db.ts (which hit the 500-line cap) along a natural boundary: everything
 * the Module 7 inbox needs. Reads are SELECT-only; the lone mutation (setLeadStatus)
 * touches only the leads table. The reply SEND path lives in app/api/reply/route.ts and
 * reuses sendOne + recordMessage — sending is never re-implemented here.
 */

import { sql, type Contact, type MessageDirection } from "./db";

// Lead funnel values live in the pure lib/lead-status module (so client components can
// import them without bundling this DB module). Re-exported for existing callers.
export { LEAD_STATUSES, type LeadStatus } from "./lead-status";

/** One conversation in the inbox list: a contact with any inbound or a lead. */
export interface InboxThreadRow {
  id: number; // contact id
  first_name: string | null;
  last_name: string | null;
  address: string | null;
  phone: string | null;
  suppressed: boolean;
  last_body: string | null;
  last_direction: MessageDirection | null;
  last_at: string | null;
  needs_reply: boolean;
  lead_id: number | null;
  lead_status: string | null;
}

/** A single message inside a thread. */
export interface ThreadMessage {
  id: number;
  direction: MessageDirection;
  body: string;
  twilio_sid: string | null;
  status: string | null;
  created_at: string;
}

/** Full thread detail for one contact: the contact, its lead (if any), all messages. */
export interface ThreadDetail {
  contact: {
    id: number;
    first_name: string | null;
    last_name: string | null;
    address: string | null;
    phone: string | null;
    suppressed: boolean;
  };
  lead: {
    id: number;
    status: string;
    notes: string | null;
    reply_text: string | null;
  } | null;
  messages: ThreadMessage[];
}

/**
 * Inbox conversation list. One row per contact that has at least one inbound message
 * OR a lead. Includes the most-recent message (body/direction/time), a needs_reply
 * flag (true when the newest message is inbound — i.e. they texted us last), the
 * contact's suppressed flag (so the UI can mark/disable opted-out threads), and the
 * latest lead status if any. Ordered by last activity, newest first.
 */
export async function getInboxThreads(limit = 200): Promise<InboxThreadRow[]> {
  const rows = await sql`
    WITH relevant AS (
      SELECT c.id
      FROM contacts c
      WHERE EXISTS (
              SELECT 1 FROM messages m
              WHERE m.contact_id = c.id AND m.direction = 'inbound'
            )
         OR EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = c.id)
    ),
    last_msg AS (
      SELECT DISTINCT ON (m.contact_id)
        m.contact_id, m.body, m.direction, m.created_at
      FROM messages m
      WHERE m.contact_id IN (SELECT id FROM relevant)
      ORDER BY m.contact_id, m.created_at DESC, m.id DESC
    )
    SELECT
      c.id,
      c.first_name,
      c.last_name,
      c.address,
      c.phone,
      c.suppressed,
      lm.body                              AS last_body,
      lm.direction                         AS last_direction,
      lm.created_at                        AS last_at,
      -- needs_reply: newest message is inbound AND the contact isn't suppressed. The
      -- AND NOT c.suppressed keeps the flag honest for an opted-out contact whose last
      -- message was a STOP (review H3) — the UI already hides the badge for suppressed
      -- rows, but the raw flag shouldn't claim a suppressed contact needs a reply.
      COALESCE(lm.direction = 'inbound' AND NOT c.suppressed, false) AS needs_reply,
      l.id                                 AS lead_id,
      l.status                             AS lead_status
    FROM relevant r
    JOIN contacts c ON c.id = r.id
    LEFT JOIN last_msg lm ON lm.contact_id = c.id
    LEFT JOIN LATERAL (
      SELECT id, status, created_at FROM leads WHERE contact_id = c.id ORDER BY id DESC LIMIT 1
    ) l ON true
    -- Order by last activity. Fall back to the lead's created_at for a lead-only contact
    -- with no messages (review H1) so it sorts by recency, not always to the bottom.
    ORDER BY COALESCE(lm.created_at, l.created_at) DESC NULLS LAST, c.id DESC
    LIMIT ${limit}
  `;
  return rows as InboxThreadRow[];
}

/** Full thread for one contact (contact + latest lead + all messages chronological). */
export async function getThread(contactId: number): Promise<ThreadDetail | null> {
  const contactRows = await sql`
    SELECT id, first_name, last_name, address, phone, suppressed
    FROM contacts
    WHERE id = ${contactId}
  `;
  if (contactRows.length === 0) return null;
  const contact = contactRows[0] as ThreadDetail["contact"];

  const leadRows = await sql`
    SELECT id, status, notes, reply_text
    FROM leads
    WHERE contact_id = ${contactId}
    ORDER BY id DESC
    LIMIT 1
  `;
  const lead = leadRows.length ? (leadRows[0] as ThreadDetail["lead"]) : null;

  const messages = await sql`
    SELECT id, direction, body, twilio_sid, status, created_at
    FROM messages
    WHERE contact_id = ${contactId}
    ORDER BY created_at ASC, id ASC
  `;

  return { contact, lead, messages: messages as ThreadMessage[] };
}

/** Load one contact by id. Used by the reply endpoint to read phone + suppression. */
export async function getContactById(id: number): Promise<Contact | null> {
  const rows = await sql`SELECT * FROM contacts WHERE id = ${id}`;
  return rows.length ? (rows[0] as Contact) : null;
}

/**
 * Is this phone on the permanent opt-out record? Compares last-10 digits on both
 * sides so formatting differences never miss a STOP. A blank phone returns true
 * (fail closed — the reply endpoint must never text a contact with no usable number).
 */
export async function isPhoneOptedOut(phone: string | null): Promise<boolean> {
  if (!phone || !phone.trim()) return true;
  const rows = await sql`
    SELECT 1 FROM opt_outs
    WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)
        = right(regexp_replace(${phone}, '[^0-9]', '', 'g'), 10)
    LIMIT 1
  `;
  return rows.length > 0;
}

export interface UpdatedLead {
  id: number;
  contact_id: number | null;
  reply_text: string | null;
  forwarded: boolean;
  forwarded_at: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}

/**
 * Update one lead's status and/or notes. An undefined field is left untouched
 * (COALESCE for status; a CASE keyed on whether notes was supplied — so notes can be
 * cleared to NULL/'' but is otherwise preserved). Returns the updated row, or null
 * if no lead has that id. Status validation is the caller's job (see /api/leads).
 */
export async function setLeadStatus(
  leadId: number,
  fields: { status?: string; notes?: string | null }
): Promise<UpdatedLead | null> {
  const status = fields.status ?? null;
  const notesProvided = fields.notes !== undefined;
  const notes = fields.notes ?? null;
  const rows = await sql`
    UPDATE leads
    SET status = COALESCE(${status}, status),
        notes  = CASE WHEN ${notesProvided} THEN ${notes} ELSE notes END
    WHERE id = ${leadId}
    RETURNING id, contact_id, reply_text, forwarded, forwarded_at, status, notes, created_at
  `;
  return rows.length ? (rows[0] as UpdatedLead) : null;
}
