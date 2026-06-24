// lib/trace-jobs.ts — persistence for Tracerfy trace jobs (durability fix, 2026-06-23).
//
// The Tracerfy queue id used to be held only in memory: a crash/reload between
// submitTrace and the result-write orphaned a PAID batch. These helpers persist the
// queue id + the contact ids submitted the instant a trace goes out, so a completed
// queue can be re-ingested by id after a crash (re-reading a queue does NOT re-charge).
//
// Kept in its own module so lib/db.ts stays under the 500-line cap (same split as
// lib/inbox-db.ts). Read/write only — the fail-closed mapping logic lives in lib/skiptrace.

import { sql } from "@/lib/db";

/** A persisted trace job. queue_id is coerced to a JS number (Tracerfy ids fit safely). */
export interface TraceJob {
  id: number;
  client_id: number;
  queue_id: number;
  status: "submitted" | "ingested";
  contact_ids: number[];
  trace_type: string;
  rows_uploaded: number | null;
  matched: number | null;
  no_match: number | null;
  created_at: string;
  ingested_at: string | null;
}

// neon returns bigint (int8) as a string to avoid precision loss; coerce to number.
// jsonb (contact_ids) comes back already parsed.
function toTraceJob(r: Record<string, unknown>): TraceJob {
  return {
    id: Number(r.id),
    client_id: Number(r.client_id),
    queue_id: Number(r.queue_id),
    status: r.status as TraceJob["status"],
    contact_ids: (r.contact_ids as number[]) ?? [],
    trace_type: (r.trace_type as string) ?? "normal",
    rows_uploaded: r.rows_uploaded === null ? null : Number(r.rows_uploaded),
    matched: r.matched === null ? null : Number(r.matched),
    no_match: r.no_match === null ? null : Number(r.no_match),
    created_at: String(r.created_at),
    ingested_at: r.ingested_at === null ? null : String(r.ingested_at),
  };
}

/**
 * Record a just-submitted trace job as 'submitted' (paid, not yet written back).
 * Call this IMMEDIATELY after submitTrace, BEFORE the long result poll, so a crash
 * during result-fetch leaves a recoverable row instead of orphaning paid results.
 */
export async function createTraceJob(args: {
  clientId: number;
  queueId: number;
  contactIds: number[];
  traceType: string;
  rowsUploaded: number;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO trace_jobs (client_id, queue_id, contact_ids, trace_type, rows_uploaded, status)
    VALUES (${args.clientId}, ${args.queueId}, ${JSON.stringify(args.contactIds)}::jsonb,
            ${args.traceType}, ${args.rowsUploaded}, 'submitted')
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/**
 * Record an already-recovered queue as 'ingested' for provenance (the manual recovery
 * of an orphaned, never-persisted job). contact_ids stays [] — the job is terminal and
 * will never be re-ingested, so the scope set is moot. Best-effort: callers tolerate failure.
 */
export async function recordIngestedTraceJob(args: {
  clientId: number;
  queueId: number;
  matched: number;
  noMatch: number;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO trace_jobs (client_id, queue_id, status, matched, no_match, ingested_at)
    VALUES (${args.clientId}, ${args.queueId}, 'ingested', ${args.matched}, ${args.noMatch}, now())
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

/** Paid-but-not-yet-ingested jobs for a client, to re-read after a crash. Oldest first. */
export async function getOutstandingTraceJobs(clientId: number): Promise<TraceJob[]> {
  const rows = await sql`
    SELECT * FROM trace_jobs WHERE client_id = ${clientId} AND status = 'submitted' ORDER BY id
  `;
  return (rows as Record<string, unknown>[]).map(toTraceJob);
}

/** Mark a job's results as written back. Idempotent (re-running just re-stamps the tallies). */
export async function markTraceJobIngested(
  clientId: number,
  id: number,
  matched: number,
  noMatch: number
): Promise<void> {
  await sql`
    UPDATE trace_jobs
    SET status = 'ingested', matched = ${matched}, no_match = ${noMatch}, ingested_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `;
}
