// lib/scrub-jobs.ts — persistence for Tracerfy DNC/litigator scrub jobs (durability fix,
// 2026-06-23). Mirror of lib/trace-jobs.ts.
//
// The scrub queue id used to be held only in memory: a crash/reload between submitScrub and
// the verdict write-back orphaned a PAID scrub. These helpers persist the queue id + the
// contact ids submitted the instant a scrub goes out, so a completed queue can be re-ingested
// by id after a crash (re-reading a queue does NOT re-charge).
//
// Kept in its own module so lib/db.ts stays under the 500-line cap (same split as
// lib/trace-jobs.ts / lib/inbox-db.ts). Read/write only — the fail-closed verdict logic
// lives in lib/scrub (classify()).

import { sql } from "@/lib/db";

/** A persisted scrub job. scrub_queue_id is coerced to a JS number (Tracerfy ids fit safely). */
export interface ScrubJob {
  id: number;
  client_id: number;
  scrub_queue_id: number;
  status: "submitted" | "ingested";
  contact_ids: number[];
  clean: number | null;
  suppressed: number | null;
  created_at: string;
  ingested_at: string | null;
}

// neon returns bigint (int8) as a string to avoid precision loss; coerce to number.
// jsonb (contact_ids) comes back already parsed.
function toScrubJob(r: Record<string, unknown>): ScrubJob {
  return {
    id: Number(r.id),
    client_id: Number(r.client_id),
    scrub_queue_id: Number(r.scrub_queue_id),
    status: r.status as ScrubJob["status"],
    contact_ids: (r.contact_ids as number[]) ?? [],
    clean: r.clean === null ? null : Number(r.clean),
    suppressed: r.suppressed === null ? null : Number(r.suppressed),
    created_at: String(r.created_at),
    ingested_at: r.ingested_at === null ? null : String(r.ingested_at),
  };
}

/**
 * Record a just-submitted scrub job as 'submitted' (paid, not yet written back).
 * Call this IMMEDIATELY after submitScrub, BEFORE the result poll, so a crash during
 * result-fetch leaves a recoverable row instead of orphaning paid results.
 */
export async function createScrubJob(args: {
  clientId: number;
  scrubQueueId: number;
  contactIds: number[];
}): Promise<number> {
  const rows = await sql`
    INSERT INTO scrub_jobs (client_id, scrub_queue_id, contact_ids, status)
    VALUES (${args.clientId}, ${args.scrubQueueId}, ${JSON.stringify(args.contactIds)}::jsonb, 'submitted')
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/** Paid-but-not-yet-ingested scrub jobs for a client, to re-read after a crash. Oldest first. */
export async function getOutstandingScrubJobs(clientId: number): Promise<ScrubJob[]> {
  const rows = await sql`
    SELECT * FROM scrub_jobs WHERE client_id = ${clientId} AND status = 'submitted' ORDER BY id
  `;
  return (rows as Record<string, unknown>[]).map(toScrubJob);
}

/** Mark a job's verdicts as written back. Idempotent (re-running just re-stamps the tallies). */
export async function markScrubJobIngested(
  clientId: number,
  id: number,
  clean: number,
  suppressed: number
): Promise<void> {
  await sql`
    UPDATE scrub_jobs
    SET status = 'ingested', clean = ${clean}, suppressed = ${suppressed}, ingested_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `;
}

/**
 * Count of contacts still needing a scrub (matched + phone + not suppressed + scrub_status
 * 'pending'). Mirrors getContactsForScrub's predicate exactly — used by the credit pre-flight
 * to report "need N, have M" before submitting anything. (A COUNT, not a row fetch.)
 */
export async function getPendingScrubCount(clientId: number, campaignId?: number): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS n
    FROM contacts
    WHERE client_id = ${clientId}
      AND (${campaignId ?? null}::int IS NULL OR campaign_id = ${campaignId ?? null}::int)
      AND skiptrace_status = 'matched'
      AND phone IS NOT NULL
      AND suppressed = false
      AND scrub_status = 'pending'
  `;
  return (rows[0] as { n: number }).n;
}
