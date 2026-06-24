// lib/scrub.ts — one batch of DNC + litigator scrubbing (shared by the API route
// and the CLI runner so the fail-closed compliance logic exists in exactly one place).
//
// Runs on contacts that are matched, have a phone, are not suppressed, AND still
// scrub_status='pending' (the load-bearing credit-safety filter — see getContactsForScrub:
// a clean contact keeps suppressed=false, so without the pending filter it was re-billed
// every chunk). Fail closed (load-bearing for compliance): a phone is left eligible ONLY if
// the scrub result explicitly marks it clean. Missing, ambiguous, or any-flag => suppress.
//
// Credit safety + durability (hotfix 2026-06-23): a credit pre-flight refuses cleanly BEFORE
// submitting if the balance can't cover the pending count (no mid-run 402), and each scrub's
// queue id is PERSISTED to scrub_jobs the instant it is submitted so a crash during the result
// fetch can be re-ingested for free instead of orphaning a paid scrub.

import { getContactsForScrub, markSuppressed, setScrubStatus, type Contact } from "@/lib/db";
import {
  createScrubJob,
  getOutstandingScrubJobs,
  markScrubJobIngested,
} from "@/lib/scrub-jobs";
import {
  getCredits,
  submitScrub,
  getScrubResults,
  normalizePhone,
  type ScrubResultRow,
} from "@/lib/tracerfy";
import {
  classify,
  creditsCoverScrub,
  emptyReasons,
  mergeReasons,
  InsufficientCreditsError,
  SCRUB_CREDITS_PER_PHONE,
  type ScrubReason,
} from "@/lib/scrub-logic";

// Re-export the pure logic so existing `@/lib/scrub` import sites (route, CLI runner) keep working.
export {
  classify,
  creditsCoverScrub,
  InsufficientCreditsError,
  SCRUB_CREDITS_PER_PHONE,
  type ScrubReason,
} from "@/lib/scrub-logic";

export interface ScrubBatchResult {
  scrubbed: number;
  clean: number;
  suppressed: number;
  byReason: Record<ScrubReason, number>;
  scrubQueueId?: number;
  recovered?: number; // contacts written back from a recovered orphaned job this run
  note?: string;
}

/** Result of applying one (already-complete) scrub queue to its contacts. */
export interface ScrubIngestResult {
  scrubQueueId: number;
  clean: number;
  suppressed: number;
  byReason: Record<ScrubReason, number>;
  ingested: number; // pending contacts in scope that were written back (clean + suppressed)
  note?: string;
}

/**
 * Apply scrub verdicts to a set of contacts. The ONE place scrub results touch contacts —
 * both a live scrub and a recovery ingest route through here so they can never diverge.
 * Per contact: any flag (or fail-closed scrub_error) => suppress + scrub_status='flagged';
 * only an explicit clean verdict => scrub_status='clean'. markSuppressed runs FIRST so a crash
 * between the two writes leaves the contact suppressed (safe + already excluded from re-billing
 * by the suppressed=false filter), never billable-and-unmarked.
 */
async function applyScrubResults(
  clientId: number,
  scope: Contact[],
  byPhone: Map<string, ScrubResultRow>
): Promise<{ clean: number; suppressed: number; byReason: Record<ScrubReason, number> }> {
  const byReason = emptyReasons();
  let suppressed = 0;
  let clean = 0;
  for (const c of scope) {
    // Defensive: the query filters NOT NULL, but the type allows null — skip, don't crash.
    if (!c.phone) continue;
    const row = byPhone.get(normalizePhone(c.phone));
    const reason = classify(row);
    if (reason) {
      await markSuppressed(clientId, c.id, reason);
      await setScrubStatus(clientId, c.id, "flagged");
      byReason[reason]++;
      suppressed++;
    } else {
      await setScrubStatus(clientId, c.id, "clean");
      clean++;
    }
  }
  return { clean, suppressed, byReason };
}

/**
 * Ingest an ALREADY-COMPLETE scrub queue into contacts. Re-reads the queue (no new scrub →
 * NO charge), then applies verdicts via the shared fail-closed mapping. Idempotent: only
 * contacts still 'pending' are considered/touched.
 *
 * Scope: opts.contactIds given → only those (still-pending) contacts (a persisted job's input);
 * omitted → ALL pending contacts.
 */
export async function ingestScrubQueue(
  clientId: number,
  scrubQueueId: number,
  opts: { contactIds?: number[] } = {}
): Promise<ScrubIngestResult> {
  const allPending = await getContactsForScrub(clientId);
  let scope = allPending;
  if (opts.contactIds) {
    const ids = new Set(opts.contactIds);
    scope = allPending.filter((c) => ids.has(c.id));
  }

  if (scope.length === 0) {
    return {
      scrubQueueId,
      clean: 0,
      suppressed: 0,
      byReason: emptyReasons(),
      ingested: 0,
      note: "nothing pending in scope",
    };
  }

  const { byPhone } = await getScrubResults(scrubQueueId);
  const { clean, suppressed, byReason } = await applyScrubResults(clientId, scope, byPhone);
  return { scrubQueueId, clean, suppressed, byReason, ingested: scope.length };
}

/**
 * Re-ingest any orphaned scrub job(s) — 'submitted' (paid) but never written back, e.g. because
 * a prior run crashed during the result poll. Re-reads each completed queue (free), applies its
 * verdicts to ONLY the contacts it submitted, and marks it 'ingested'. Run at the start of every
 * scrub so a crash can never permanently strand a paid scrub (or leave a contact re-billable).
 */
export async function ingestOutstandingScrubJobs(clientId: number): Promise<ScrubIngestResult[]> {
  const jobs = await getOutstandingScrubJobs(clientId);
  const results: ScrubIngestResult[] = [];
  for (const job of jobs) {
    const res = await ingestScrubQueue(clientId, job.scrub_queue_id, { contactIds: job.contact_ids });
    await markScrubJobIngested(clientId, job.id, res.clean, res.suppressed);
    results.push(res);
  }
  return results;
}

/**
 * Scrub up to `limit` matched-but-unscrubbed contacts (all if omitted). RESUMABLE: first recovers
 * any orphaned scrub job, then scrubs only still-pending contacts; the new job's queue id is
 * persisted BEFORE the result poll, so a crash mid-fetch is recoverable on the next run. Suppresses
 * any flagged/ambiguous number and marks scrub_status; only an explicit clean verdict sets
 * scrub_status='clean'. Throws InsufficientCreditsError if the balance can't cover the batch
 * (nothing is spent in that case).
 *
 * Prefers scrub-from-queue ONLY when `traceQueueId` is explicitly passed (it scrubs the ENTIRE
 * trace queue, so it is NOT scoped to pending and must not be used to resume a partial scrub —
 * the default phone-list path bills exactly the pending contacts).
 */
export async function scrubBatch(
  clientId: number,
  opts: { limit?: number; traceQueueId?: number; phoneColumns?: string[] } = {}
): Promise<ScrubBatchResult> {
  // RESUME step: write back any paid-but-orphaned scrub job(s) before considering a new scrub.
  const recovered = await ingestOutstandingScrubJobs(clientId);
  const recoveredClean = recovered.reduce((a, r) => a + r.clean, 0);
  const recoveredSuppressed = recovered.reduce((a, r) => a + r.suppressed, 0);
  const recoveredCount = recovered.reduce((a, r) => a + r.ingested, 0);
  const recoveredByReason = mergeReasons(recovered.map((r) => r.byReason));

  const contacts = await getContactsForScrub(clientId, opts.limit);
  if (contacts.length === 0) {
    return {
      scrubbed: recoveredCount,
      clean: recoveredClean,
      suppressed: recoveredSuppressed,
      byReason: recoveredByReason,
      recovered: recoveredCount,
      note: recoveredCount > 0 ? "recovered orphaned job(s); nothing new to scrub" : "nothing to scrub",
    };
  }

  // CREDIT PRE-FLIGHT: refuse cleanly BEFORE submitting if the balance can't cover the batch,
  // so a run can never die mid-call on a 402 (and can never silently re-bill its way to empty).
  const credits = await getCredits();
  if (!creditsCoverScrub(credits, contacts.length)) {
    throw new InsufficientCreditsError(
      credits,
      contacts.length * SCRUB_CREDITS_PER_PHONE,
      contacts.length
    );
  }

  // Prefer scrub-from-queue ONLY if a trace queue id is explicitly supplied (see note above);
  // otherwise scrub the explicit phone list — exactly the pending contacts, nothing re-billed.
  const contactIds = contacts.map((c) => c.id);
  const { scrubQueueId } = opts.traceQueueId
    ? await submitScrub({ queueId: opts.traceQueueId, phoneColumns: opts.phoneColumns })
    : await submitScrub({ phones: contacts.map((c) => normalizePhone(c.phone)) });

  // DURABILITY: persist the scrub queue id + this batch's contact ids the instant the scrub is
  // submitted — BEFORE the result poll — so a crash/reload during the fetch leaves a recoverable
  // 'submitted' job instead of orphaning a paid scrub.
  const jobId = await createScrubJob({ clientId, scrubQueueId, contactIds });

  const res = await ingestScrubQueue(clientId, scrubQueueId, { contactIds });
  await markScrubJobIngested(clientId, jobId, res.clean, res.suppressed);

  return {
    scrubbed: res.ingested + recoveredCount,
    clean: res.clean + recoveredClean,
    suppressed: res.suppressed + recoveredSuppressed,
    byReason: mergeReasons([res.byReason, recoveredByReason]),
    scrubQueueId,
    recovered: recoveredCount,
  };
}

