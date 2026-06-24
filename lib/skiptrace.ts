// lib/skiptrace.ts — one batch of Tracerfy skip tracing (shared by the API route
// and the CLI runner so the fail-closed logic exists in exactly one place).
//
// Idempotent: only contacts with skiptrace_status='pending' are traced, so a re-run
// never re-traces matched/no_match rows. Fail closed: a no-match is suppressed
// (suppress_reason='no_match') so an unverified number can never enter the send path.
//
// Durability (hotfix 2026-06-23): a trace's queue id is PERSISTED to trace_jobs the
// instant it is submitted, and a run RESUMES by re-ingesting any orphaned (paid but
// not-yet-written-back) job FIRST. A crash/reload between submit and result-write can
// no longer strand paid-for results — re-reading a completed queue does not re-charge.

import { getContactsForSkiptrace, setTraceResult, markSuppressed, type Contact } from "@/lib/db";
import {
  createTraceJob,
  getOutstandingTraceJobs,
  markTraceJobIngested,
} from "@/lib/trace-jobs";
import {
  getCredits,
  submitTrace,
  getTraceResults,
  matchKey,
  type TraceResultRow,
  type TraceType,
} from "@/lib/tracerfy";

export interface TraceBatchResult {
  traced: number;
  matched: number;
  noMatch: number;
  queueId?: number;
  recovered?: number; // contacts written back from a recovered orphaned job this run
  note?: string;
}

/** Result of ingesting one (already-complete) trace queue. */
export interface IngestResult {
  queueId: number;
  matched: number;
  noMatch: number;
  ingested: number; // pending contacts in scope that were written back (matched + noMatch)
  note?: string;
}

/** Thrown when the Tracerfy balance can't cover the batch — stop before spending. */
export class InsufficientCreditsError extends Error {
  constructor(
    public credits: number,
    public needed: number,
    public pending: number
  ) {
    super(`insufficient_credits: have ${credits}, need ${needed} for ${pending} pending`);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * Map parsed trace rows back to a set of contacts and write the results, fail closed.
 * The ONE place trace results touch contacts — both a live trace and a recovery ingest
 * route through here so they can never diverge. Only the given (still-pending) contacts
 * are touched; a contact with no usable mobile in the results is suppressed (no_match).
 */
async function applyTraceRows(
  clientId: number,
  scope: Contact[],
  rows: TraceResultRow[]
): Promise<{ matched: number; noMatch: number }> {
  // Map results back to contacts by normalized address+city+state (no zip in the CSV).
  const resultByKey = new Map<string, TraceResultRow>();
  for (const r of rows) {
    if (r.matched && r.phone) resultByKey.set(matchKey(r.address, r.city, r.state), r);
  }

  let matched = 0;
  let noMatch = 0;
  for (const c of scope) {
    const hit = resultByKey.get(matchKey(c.address, c.city, c.state));
    if (hit && hit.phone) {
      await setTraceResult(clientId, c.id, { phone: hit.phone, phoneType: hit.phoneType, status: "matched" });
      matched++;
    } else {
      // Fail closed: no usable mobile => suppress so it can never enter the send path.
      await setTraceResult(clientId, c.id, { phone: null, phoneType: null, status: "no_match" });
      await markSuppressed(clientId, c.id, "no_match");
      noMatch++;
    }
  }
  return { matched, noMatch };
}

/**
 * Ingest an ALREADY-COMPLETE Tracerfy trace queue into contacts. Re-reads the queue
 * (no new trace → NO charge), then applies results via the shared fail-closed mapping.
 * Idempotent: only contacts still 'pending' are considered/touched.
 *
 * Scope:
 *  - opts.contactIds given  → only those (still-pending) contacts — a persisted job's input.
 *  - omitted                → ALL pending contacts — the manual recovery of an orphaned job
 *                             that was never persisted and is known to cover the whole pending set.
 */
export async function ingestTraceQueue(
  clientId: number,
  queueId: number,
  opts: { contactIds?: number[] } = {}
): Promise<IngestResult> {
  const allPending = await getContactsForSkiptrace(clientId);
  let scope = allPending;
  if (opts.contactIds) {
    const ids = new Set(opts.contactIds);
    scope = allPending.filter((c) => ids.has(c.id));
  }

  if (scope.length === 0) {
    return { queueId, matched: 0, noMatch: 0, ingested: 0, note: "nothing pending in scope" };
  }

  // The job is already complete, so the first fetch returns every available row; the
  // bounded poll is only a guard against an incremental read (returns whatever arrived).
  const { rows } = await getTraceResults(queueId, {
    expectedRows: scope.length,
    maxAttempts: 6,
    intervalMs: 4000,
  });

  const { matched, noMatch } = await applyTraceRows(clientId, scope, rows);
  return { queueId, matched, noMatch, ingested: scope.length };
}

/**
 * Re-ingest any orphaned trace job(s) — 'submitted' (paid) but never written back, e.g.
 * because a prior run crashed during the result poll. Re-reads each completed queue (free),
 * applies its results to ONLY the contacts it submitted, and marks it 'ingested'. Run this
 * at the start of every trace so a crash can never permanently strand paid-for results.
 */
export async function ingestOutstandingJobs(clientId: number): Promise<IngestResult[]> {
  const jobs = await getOutstandingTraceJobs(clientId);
  const results: IngestResult[] = [];
  for (const job of jobs) {
    const res = await ingestTraceQueue(clientId, job.queue_id, { contactIds: job.contact_ids });
    await markTraceJobIngested(clientId, job.id, res.matched, res.noMatch);
    results.push(res);
  }
  return results;
}

/**
 * Trace up to `limit` pending contacts (all pending if omitted). RESUMABLE: first recovers
 * any orphaned job, then traces only still-pending contacts; the new job's queue id is
 * persisted BEFORE the result poll, so a crash mid-fetch is recoverable on the next run.
 * Writes phones for matches and suppresses no-matches. Throws InsufficientCreditsError if
 * the balance can't cover the batch (nothing is spent in that case).
 */
export async function traceBatch(
  clientId: number,
  opts: { limit?: number; traceType?: TraceType } = {}
): Promise<TraceBatchResult> {
  const traceType: TraceType = opts.traceType === "advanced" ? "advanced" : "normal";

  // RESUME step: write back any paid-but-orphaned job(s) before considering a new trace.
  const recovered = await ingestOutstandingJobs(clientId);
  const recoveredMatched = recovered.reduce((a, r) => a + r.matched, 0);
  const recoveredNoMatch = recovered.reduce((a, r) => a + r.noMatch, 0);
  const recoveredCount = recovered.reduce((a, r) => a + r.ingested, 0);

  const pending = await getContactsForSkiptrace(clientId, opts.limit);
  if (pending.length === 0) {
    return {
      traced: recoveredCount,
      matched: recoveredMatched,
      noMatch: recoveredNoMatch,
      recovered: recoveredCount,
      note: recoveredCount > 0 ? "recovered orphaned job(s); nothing new pending" : "nothing pending",
    };
  }

  // Pre-flight credit guard: stop before spending if we can't cover the batch.
  const credits = await getCredits();
  const perLead = traceType === "advanced" ? 2 : 1;
  if (credits < pending.length * perLead) {
    throw new InsufficientCreditsError(credits, pending.length * perLead, pending.length);
  }

  const contactIds = pending.map((c) => c.id);
  const { queueId, rowsUploaded } = await submitTrace(
    pending.map((c) => ({
      address: c.address,
      city: c.city,
      state: c.state,
      zip: c.zip,
      firstName: c.first_name,
      lastName: c.last_name,
    })),
    { traceType }
  );

  // DURABILITY: persist the queue id + this batch's contact ids the instant the trace is
  // submitted — BEFORE the (multi-minute) result poll — so a crash/reload during the fetch
  // leaves a recoverable 'submitted' job instead of orphaning paid-for results. (The only
  // remaining window is the millisecond between submit and this write; the prior bug left
  // the ENTIRE fetch unprotected.)
  const jobId = await createTraceJob({ clientId, queueId, contactIds, traceType, rowsUploaded });

  const res = await ingestTraceQueue(clientId, queueId, { contactIds });
  await markTraceJobIngested(clientId, jobId, res.matched, res.noMatch);

  return {
    traced: res.ingested + recoveredCount,
    matched: res.matched + recoveredMatched,
    noMatch: res.noMatch + recoveredNoMatch,
    queueId,
    recovered: recoveredCount,
  };
}
