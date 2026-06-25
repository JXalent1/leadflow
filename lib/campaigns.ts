/**
 * lib/campaigns.ts — the campaign record + per-client campaign resolution. (v2 Module V2)
 *
 * A client runs MANY campaigns over time. A campaign owns its own contact list and its own
 * trace -> scrub -> send lifecycle; a contact belongs to exactly one campaign (and thus one
 * client). Every query here is scoped by client_id so one client can never read or create a
 * campaign under another — and resolveCampaignForClient validates that a requested campaign id
 * actually belongs to the resolved client before any pipeline operation acts on it.
 *
 * Suppression is NOT campaign-level — it stays CLIENT-level by phone (see opt_outs +
 * getEligibleContacts). Campaigns only partition the contact list / send lifecycle.
 */

import { sql } from "@/lib/db";

/** The migrated pilot. Operator surfaces default here for client 1 when no campaign is selected. */
export const DEFAULT_CAMPAIGN_ID = 1;

export type CampaignStatus =
  | "draft"
  | "ready"
  | "tracing"
  | "scrubbing"
  | "sending"
  | "done"
  | "paused";

/**
 * Per-campaign scrub mode (Module N). 'vendor' = the existing Tracerfy scrub (default, unchanged);
 * 'none' = the passthrough that marks traced contacts clean with no vendor call/spend.
 */
export type ScrubMode = "vendor" | "none";

/** Validate an untrusted scrub_mode value. */
export function isScrubMode(v: unknown): v is ScrubMode {
  return v === "vendor" || v === "none";
}

export interface Campaign {
  id: number;
  client_id: number;
  name: string;
  status: string;
  message_template: string | null;
  scrub_mode: ScrubMode;
  created_at: string;
}

/** A campaign joined to its contact count, for the operator's campaign selector. */
export interface CampaignSummary extends Campaign {
  contact_count: number;
}

function toCampaign(r: Record<string, unknown>): Campaign {
  return {
    id: Number(r.id),
    client_id: Number(r.client_id),
    name: String(r.name),
    status: String(r.status),
    message_template: (r.message_template as string | null) ?? null,
    scrub_mode: isScrubMode(r.scrub_mode) ? r.scrub_mode : "vendor",
    created_at: String(r.created_at),
  };
}

/** Load one campaign by id, WITHIN one client (null if it doesn't exist OR belongs to another). */
export async function getCampaignForClient(
  clientId: number,
  campaignId: number
): Promise<Campaign | null> {
  if (!Number.isInteger(campaignId) || campaignId <= 0) return null;
  const rows = await sql`
    SELECT * FROM campaigns WHERE id = ${campaignId} AND client_id = ${clientId}
  `;
  return rows.length ? toCampaign(rows[0] as Record<string, unknown>) : null;
}

/** All of a client's campaigns + their contact counts, newest-meaningful order (oldest id first). */
export async function listCampaigns(clientId: number): Promise<CampaignSummary[]> {
  const rows = await sql`
    SELECT c.*, (SELECT COUNT(*) FROM contacts ct WHERE ct.campaign_id = c.id)::int AS contact_count
    FROM campaigns c
    WHERE c.client_id = ${clientId}
    ORDER BY c.id
  `;
  return (rows as Record<string, unknown>[]).map((r) => ({
    ...toCampaign(r),
    contact_count: Number(r.contact_count),
  }));
}

/** Create a new campaign for a client (status 'draft'). Returns its id. scrubMode defaults to 'vendor'. */
export async function createCampaign(
  clientId: number,
  name: string,
  messageTemplate?: string | null,
  scrubMode: ScrubMode = "vendor"
): Promise<number> {
  const rows = await sql`
    INSERT INTO campaigns (client_id, name, message_template, scrub_mode)
    VALUES (${clientId}, ${name}, ${messageTemplate ?? null}, ${scrubMode})
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/**
 * Set a campaign's scrub mode, scoped to its client. Validates the value (rejects anything other than
 * 'vendor'|'none'). Returns true if a row was updated (the campaign exists + belongs to the client).
 */
export async function setCampaignScrubMode(
  clientId: number,
  campaignId: number,
  mode: ScrubMode
): Promise<boolean> {
  if (!isScrubMode(mode)) return false;
  const rows = await sql`
    UPDATE campaigns SET scrub_mode = ${mode}
    WHERE id = ${campaignId} AND client_id = ${clientId}
    RETURNING id
  `;
  return rows.length > 0;
}

/** Update a campaign's lifecycle status, scoped to its client. */
export async function setCampaignStatus(
  clientId: number,
  campaignId: number,
  status: CampaignStatus
): Promise<void> {
  await sql`
    UPDATE campaigns SET status = ${status} WHERE id = ${campaignId} AND client_id = ${clientId}
  `;
}

/**
 * Resolve which campaign an operator request acts on, for a given client.
 *
 * - If `requested` is a campaign that BELONGS to `clientId`, use it.
 * - Otherwise fall back to the client's default (lowest-id) campaign — for client 1 that is the
 *   migrated pilot (campaign 1), so a request with no campaignId behaves exactly as before V2.
 * - Returns null only if the client has no campaigns at all.
 *
 * The belongs-to-client check is load-bearing: it prevents `?clientId=1&campaignId=<other
 * client's campaign>` from ever pointing the pipeline at another tenant's list.
 */
export async function resolveCampaignForClient(
  clientId: number,
  requested?: number
): Promise<Campaign | null> {
  if (requested && Number.isInteger(requested) && requested > 0) {
    const c = await getCampaignForClient(clientId, requested);
    if (c) return c;
  }
  const rows = await sql`
    SELECT * FROM campaigns WHERE client_id = ${clientId} ORDER BY id LIMIT 1
  `;
  return rows.length ? toCampaign(rows[0] as Record<string, unknown>) : null;
}
