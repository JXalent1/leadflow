/**
 * lib/campaign-runs.ts — the send-run record + the concurrent-run guard. (v2 Module V3)
 *
 * Extracted from lib/db.ts so the auto-driving send pipeline's run lifecycle lives in one place
 * (and to keep db.ts ≤500 lines). In V3 a "run" spans the WHOLE client-side-driven send for a
 * campaign, not one HTTP batch: the driver opens a run, sends batch after batch through the SAME
 * per-batch path (getEligibleContacts + the atomic claimForSend), heartbeats the run each batch
 * (last_batch_at), and finishes it (finished_at) only when nothing eligible remains. The guard
 * lets the driver continue its OWN run — matched by id — while blocking a second concurrent
 * operator; the per-contact atomic claim remains the real no-double-text guarantee.
 *
 * NO eligibility/suppression logic lives here — that stays in getEligibleContacts/claimForSend.
 */

import { sql } from "@/lib/db";

/** The minimal shape of an in-flight run the guard/driver needs. */
export interface ActiveRun {
  id: number;
  sent_count: number;
}

/** Open a campaign run row for a client + campaign; returns its id. (Session 3; campaign_id v2 V2) */
export async function createCampaignRun(
  clientId: number,
  campaignId: number,
  totalEligible: number,
  note?: string
): Promise<number> {
  const rows = await sql`
    INSERT INTO campaign_runs (client_id, campaign_id, total_eligible, note, last_batch_at)
    VALUES (${clientId}, ${campaignId}, ${totalEligible}, ${note ?? null}, now())
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/**
 * Heartbeat a run mid-drive: add this batch's sent count and stamp last_batch_at. (v2 V3.)
 * Called after a batch when MORE eligible contacts remain — the run stays open (finished_at NULL)
 * so it keeps representing the ongoing drive (and keeps the active-run guard tripped for others).
 */
export async function touchCampaignRun(
  clientId: number,
  id: number,
  sentDelta: number
): Promise<void> {
  await sql`
    UPDATE campaign_runs
    SET sent_count = COALESCE(sent_count, 0) + ${sentDelta}, last_batch_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `;
}

/**
 * Close a run: add the final batch's sent count, set the note, and stamp finished_at. (Session 3;
 * made additive in v2 V3 so a multi-batch driven run accumulates its per-batch sent counts.)
 */
export async function finishCampaignRun(
  clientId: number,
  id: number,
  sentDelta: number,
  note?: string
): Promise<void> {
  await sql`
    UPDATE campaign_runs
    SET sent_count = COALESCE(sent_count, 0) + ${sentDelta},
        note = ${note ?? null},
        last_batch_at = now(),
        finished_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `;
}

/**
 * The run currently in flight FOR THIS CLIENT (optionally one campaign), or null. (Session 3
 * review — concurrent-run guard; returns the row in v2 V3 so the driver can match its OWN run.)
 *
 * "Active" = finished_at IS NULL and the last heartbeat (COALESCE(last_batch_at, started_at)) is
 * within `withinMinutes` (default 6, just above the 5-min function maxDuration). A run whose
 * driver died stops heartbeating and therefore goes stale, so a crash never blocks future runs
 * forever. Scoped per client so one client's run can't block another's. Not a perfect mutex
 * (stateless HTTP driver); the atomic per-contact claim is the real no-double-text guarantee.
 */
export async function getActiveCampaignRun(
  clientId: number,
  campaignId?: number,
  withinMinutes = 6
): Promise<ActiveRun | null> {
  const rows = await sql`
    SELECT id, COALESCE(sent_count, 0)::int AS sent_count FROM campaign_runs
    WHERE client_id = ${clientId}
      AND (${campaignId ?? null}::int IS NULL OR campaign_id = ${campaignId ?? null}::int)
      AND finished_at IS NULL
      AND COALESCE(last_batch_at, started_at) > now() - make_interval(mins => ${withinMinutes})
    ORDER BY id DESC
    LIMIT 1
  `;
  return rows.length ? (rows[0] as ActiveRun) : null;
}

/** Boolean form of the guard for the dashboard snapshot. (Session 3) */
export async function hasActiveCampaignRun(
  clientId: number,
  campaignId?: number,
  withinMinutes = 6
): Promise<boolean> {
  return (await getActiveCampaignRun(clientId, campaignId, withinMinutes)) !== null;
}
