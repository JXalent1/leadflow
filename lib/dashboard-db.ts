/**
 * lib/dashboard-db.ts — READ-ONLY dashboard read helpers, scoped per client. (Session 5; split
 * out of lib/db.ts in v2 Module V1 to keep db.ts ≤500 lines and to add client_id scoping.)
 *
 * Every query is a SELECT scoped by client_id. No mutation lives here; the dashboard's buttons
 * call the existing /api/{skiptrace,scrub,campaign} endpoints for any write. One client's
 * dashboard never reads another client's leads, replies, or opt-outs.
 */

import { sql } from "@/lib/db";

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

/**
 * Extra count cards not covered by getContactCounts/getSendProgress, for one client + campaign.
 * (campaign scope added v2 V2.) scrubbedClean is the campaign's clean contacts; leads counts the
 * campaign's leads (leads joined to a contact in this campaign).
 */
export async function getDashboardExtraCounts(
  clientId: number,
  campaignId: number
): Promise<{
  scrubbedClean: number;
  leads: number;
}> {
  const rows = await sql`
    SELECT
      (SELECT COUNT(*) FROM contacts
         WHERE client_id = ${clientId} AND campaign_id = ${campaignId}
           AND scrub_status = 'clean')::int                                              AS scrubbed_clean,
      (SELECT COUNT(*) FROM leads l
         JOIN contacts c ON c.id = l.contact_id AND c.client_id = l.client_id
         WHERE l.client_id = ${clientId} AND c.campaign_id = ${campaignId})::int          AS leads
  `;
  const r = rows[0] as { scrubbed_clean: number; leads: number };
  return { scrubbedClean: r.scrubbed_clean, leads: r.leads };
}

/** Most-recent leads (one client + campaign) joined to their contact. Newest first. */
export async function getRecentLeads(
  clientId: number,
  campaignId: number,
  limit = 50
): Promise<LeadRow[]> {
  const rows = await sql`
    SELECT
      l.id, l.contact_id, l.reply_text, l.forwarded, l.forwarded_at, l.status, l.created_at,
      c.first_name, c.last_name, c.address, c.phone
    FROM leads l
    JOIN contacts c ON c.id = l.contact_id AND c.client_id = l.client_id
    WHERE l.client_id = ${clientId} AND c.campaign_id = ${campaignId}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit}
  `;
  return rows as LeadRow[];
}

/**
 * Most-recent inbound messages for one client + campaign. Newest first. (campaign scope v2 V2.)
 * LEFT JOIN + `OR m.contact_id IS NULL` so an ORPHAN inbound — a STOP/reply from a number we have
 * no contact row for (messages has no campaign_id to scope it by) — is still surfaced rather than
 * silently dropped. Orphan opt-outs also appear in the (client-level) opt-out list.
 */
export async function getRecentInbound(
  clientId: number,
  campaignId: number,
  limit = 50
): Promise<InboundRow[]> {
  const rows = await sql`
    SELECT
      m.id, m.contact_id, m.body, m.created_at,
      c.first_name, c.last_name, c.phone
    FROM messages m
    LEFT JOIN contacts c ON c.id = m.contact_id AND c.client_id = m.client_id
    WHERE m.client_id = ${clientId}
      AND m.direction = 'inbound'
      AND (c.campaign_id = ${campaignId} OR m.contact_id IS NULL)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit}
  `;
  return rows as InboundRow[];
}

/** Most-recent opt-outs (one client) joined to their contact (if matched). Newest first. */
export async function getRecentOptOuts(clientId: number, limit = 50): Promise<OptOutRow[]> {
  const rows = await sql`
    SELECT
      o.id, o.phone, o.created_at,
      c.first_name, c.last_name
    FROM opt_outs o
    LEFT JOIN contacts c ON c.id = o.contact_id AND c.client_id = o.client_id
    WHERE o.client_id = ${clientId}
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${limit}
  `;
  return rows as OptOutRow[];
}
