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
//
// Resilience (2026-06-29): the submit + credit + poll calls are wrapped in withRetry so
// a single TRANSIENT Tracerfy error (429/timeout/5xx) no longer kills the run — it backs
// off and retries. A terminal credit shortfall still stops cleanly (InsufficientCredits-
// Error, nothing spent). A poison input (no usable address) is screened out pre-submit
// and suppressed fail-closed (no_match) so one bad record can't waste a credit or block
// the batch. All external functions are injectable (deps) so tests mock Tracerfy + the DB
// with no real API spend.

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
import { withRetry, isTransientError, type RetryOptions } from "@/lib/retry";

export interface TraceBatchResult {
  traced: number;
  matched: number;
  noMatch: number;
  queueId?: number;
  recovered?: number; // contacts written back from a recovered orphaned job this run
  skipped?: number; // poison records (no usable address) suppressed fail-closed, not submitted
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

/**
 * The external collaborators traceBatch touches — the DB writers + the Tracerfy client.
 * Defaults to the real implementations; tests pass fakes so the whole batch (including
 * retry/backoff, poison-skip, and orphaned-job recovery) runs with no DB and no API spend.
 */
export interface TraceDeps {
  getContactsForSkiptrace: typeof getContactsForSkiptrace;
  setTraceResult: typeof setTraceResult;
  markSuppressed: typeof markSuppressed;
  createTraceJob: typeof createTraceJob;
  getOutstandingTraceJobs: typeof getOutstandingTraceJobs;
  markTraceJobIngested: typeof markTraceJobIngested;
  getCredits: typeof getCredits;
  submitTrace: typeof submitTrace;
  getTraceResults: typeof getTraceResults;
}

const defaultDeps: TraceDeps = {
  getContactsForSkiptrace,
  setTraceResult,
  markSuppressed,
  createTraceJob,
  getOutstandingTraceJobs,
  markTraceJobIngested,
  getCredits,
  submitTrace,
  getTraceResults,
};

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

/** Default retry policy for a trace call, with a label so retries are logged. Test
 *  overrides (sleep/rng/maxAttempts) win — they're spread last. */
function traceRetry(label: string, overrides: RetryOptions = {}): RetryOptions {
  return {
    isRetryable: isTransientError,
    onRetry: ({ attempt, delayMs, err }) =>
      console.warn(
        `[skiptrace] transient ${label} error (attempt ${attempt}); retrying in ${delayMs}ms: ${
          err instanceof Error ? err.message : String(err)
        }`
      ),
    ...overrides,
  };
}

/**
 * A trace input with no usable situs address can never be matched back to its result
 * (the match key would be empty) and would only waste a credit — it's a "poison" record.
 * Returns false for such inputs so they're screened out of the submitted batch and
 * suppressed fail-closed (no_match) instead of killing or silently corrupting the run.
 */
export function isTraceable(c: { address: string | null }): boolean {
  return typeof c.address === "string" && c.address.trim().length > 0;
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
  rows: TraceResultRow[],
  deps: TraceDeps
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
      await deps.setTraceResult(clientId, c.id, { phone: hit.phone, phoneType: hit.phoneType, status: "matched" });
      matched++;
    } else {
      // Fail closed: no usable mobile => suppress so it can never enter the send path.
      await deps.setTraceResult(clientId, c.id, { phone: null, phoneType: null, status: "no_match" });
      await deps.markSuppressed(clientId, c.id, "no_match");
      noMatch++;
    }
  }
  return { matched, noMatch };
}

/** Suppress a poison record fail-closed (no usable address → no_match), never submitted. */
async function suppressPoison(clientId: number, contacts: Contact[], deps: TraceDeps): Promise<number> {
  for (const c of contacts) {
    await deps.setTraceResult(clientId, c.id, { phone: null, phoneType: null, status: "no_match" });
    await deps.markSuppressed(clientId, c.id, "no_match");
  }
  return contacts.length;
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
  opts: { contactIds?: number[] } = {},
  deps: TraceDeps = defaultDeps,
  retry: RetryOptions = {}
): Promise<IngestResult> {
  const allPending = await deps.getContactsForSkiptrace(clientId);
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
  // Re-reading a queue NEVER charges, so retrying a transient poll error is free + safe.
  const { rows } = await withRetry(
    () =>
      deps.getTraceResults(queueId, {
        expectedRows: scope.length,
        maxAttempts: 6,
        intervalMs: 4000,
      }),
    traceRetry("getTraceResults", retry)
  );

  const { matched, noMatch } = await applyTraceRows(clientId, scope, rows, deps);
  return { queueId, matched, noMatch, ingested: scope.length };
}

/**
 * Re-ingest any orphaned trace job(s) — 'submitted' (paid) but never written back, e.g.
 * because a prior run crashed during the result poll. Re-reads each completed queue (free),
 * applies its results to ONLY the contacts it submitted, and marks it 'ingested'. Run this
 * at the start of every trace so a crash can never permanently strand paid-for results.
 */
export async function ingestOutstandingJobs(
  clientId: number,
  deps: TraceDeps = defaultDeps,
  retry: RetryOptions = {}
): Promise<IngestResult[]> {
  const jobs = await deps.getOutstandingTraceJobs(clientId);
  const results: IngestResult[] = [];
  for (const job of jobs) {
    const res = await ingestTraceQueue(clientId, job.queue_id, { contactIds: job.contact_ids }, deps, retry);
    await deps.markTraceJobIngested(clientId, job.id, res.matched, res.noMatch);
    results.push(res);
  }
  return results;
}

/**
 * Trace up to `limit` pending contacts (all pending if omitted). RESUMABLE: first recovers
 * any orphaned job, then traces only still-pending contacts; the new job's queue id is
 * persisted BEFORE the result poll, so a crash mid-fetch is recoverable on the next run.
 * Writes phones for matches and suppresses no-matches. Throws InsufficientCreditsError if
 * the balance can't cover the batch (nothing is spent in that case). Transient Tracerfy
 * errors are retried with backoff; poison records (no usable address) are screened out.
 */
export async function traceBatch(
  clientId: number,
  opts: { campaignId?: number; limit?: number; traceType?: TraceType } = {},
  deps: TraceDeps = defaultDeps,
  retry: RetryOptions = {}
): Promise<TraceBatchResult> {
  const traceType: TraceType = opts.traceType === "advanced" ? "advanced" : "normal";

  // RESUME step: write back any paid-but-orphaned job(s) before considering a new trace. This is
  // CLIENT-wide (not campaign-scoped) on purpose — orphaned jobs are pinned to the exact
  // contact_ids they submitted, recovering them is free + never crosses a client boundary, and
  // failing to recover would strand paid results. New tracing below is scoped to opts.campaignId.
  const recovered = await ingestOutstandingJobs(clientId, deps, retry);
  const recoveredMatched = recovered.reduce((a, r) => a + r.matched, 0);
  const recoveredNoMatch = recovered.reduce((a, r) => a + r.noMatch, 0);
  const recoveredCount = recovered.reduce((a, r) => a + r.ingested, 0);

  const pending = await deps.getContactsForSkiptrace(clientId, {
    campaignId: opts.campaignId,
    limit: opts.limit,
  });
  if (pending.length === 0) {
    return {
      traced: recoveredCount,
      matched: recoveredMatched,
      noMatch: recoveredNoMatch,
      recovered: recoveredCount,
      note: recoveredCount > 0 ? "recovered orphaned job(s); nothing new pending" : "nothing pending",
    };
  }

  // Screen out poison records (no usable address) BEFORE any spend: suppress them fail-closed
  // (no_match) so one bad input can never waste a credit or block the rest of the batch.
  const traceable = pending.filter(isTraceable);
  const poison = pending.filter((c) => !isTraceable(c));
  const skipped = await suppressPoison(clientId, poison, deps);

  if (traceable.length === 0) {
    return {
      traced: recoveredCount + skipped,
      matched: recoveredMatched,
      noMatch: recoveredNoMatch + skipped,
      recovered: recoveredCount,
      skipped,
      note: "skipped poison record(s) with no usable address; nothing traceable",
    };
  }

  // Pre-flight credit guard: stop before spending if we can't cover the (traceable) batch.
  // Retried on transient errors — reading the balance never charges.
  const credits = await withRetry(() => deps.getCredits(), traceRetry("getCredits", retry));
  const perLead = traceType === "advanced" ? 2 : 1;
  if (credits < traceable.length * perLead) {
    throw new InsufficientCreditsError(credits, traceable.length * perLead, traceable.length);
  }

  const contactIds = traceable.map((c) => c.id);
  // Retry a transient submit failure (429/timeout/5xx). The dominant case is a 429 — the
  // request is rejected, so no queue is created and no credit is spent; the retry is safe.
  const { queueId, rowsUploaded } = await withRetry(
    () =>
      deps.submitTrace(
        traceable.map((c) => ({
          address: c.address,
          city: c.city,
          state: c.state,
          zip: c.zip,
          firstName: c.first_name,
          lastName: c.last_name,
        })),
        { traceType }
      ),
    traceRetry("submitTrace", retry)
  );

  // DURABILITY: persist the queue id + this batch's contact ids the instant the trace is
  // submitted — BEFORE the (multi-minute) result poll — so a crash/reload during the fetch
  // leaves a recoverable 'submitted' job instead of orphaning paid-for results. (The only
  // remaining window is the millisecond between submit and this write; the prior bug left
  // the ENTIRE fetch unprotected.)
  const jobId = await deps.createTraceJob({ clientId, queueId, contactIds, traceType, rowsUploaded });

  const res = await ingestTraceQueue(clientId, queueId, { contactIds }, deps, retry);
  await deps.markTraceJobIngested(clientId, jobId, res.matched, res.noMatch);

  return {
    traced: res.ingested + recoveredCount + skipped,
    matched: res.matched + recoveredMatched,
    noMatch: res.noMatch + recoveredNoMatch + skipped,
    queueId,
    recovered: recoveredCount,
    skipped,
  };
}
