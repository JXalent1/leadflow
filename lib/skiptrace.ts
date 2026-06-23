// lib/skiptrace.ts — one batch of Tracerfy skip tracing (shared by the API route
// and the CLI runner so the fail-closed logic exists in exactly one place).
//
// Idempotent: only contacts with skiptrace_status='pending' are traced, so a re-run
// never re-traces matched/no_match rows. Fail closed: a no-match is suppressed
// (suppress_reason='no_match') so an unverified number can never enter the send path.

import { getContactsForSkiptrace, setTraceResult, markSuppressed } from "@/lib/db";
import {
  getCredits,
  submitTrace,
  getTraceResults,
  matchKey,
  type TraceType,
} from "@/lib/tracerfy";

export interface TraceBatchResult {
  traced: number;
  matched: number;
  noMatch: number;
  queueId?: number;
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
 * Trace up to `limit` pending contacts (all pending if omitted). Writes phones for
 * matches and suppresses no-matches. Throws InsufficientCreditsError if the balance
 * can't cover the batch (nothing is spent in that case).
 */
export async function traceBatch(
  opts: { limit?: number; traceType?: TraceType } = {}
): Promise<TraceBatchResult> {
  const traceType: TraceType = opts.traceType === "advanced" ? "advanced" : "normal";

  const pending = await getContactsForSkiptrace(opts.limit);
  if (pending.length === 0) {
    return { traced: 0, matched: 0, noMatch: 0, note: "nothing pending" };
  }

  // Pre-flight credit guard: stop before spending if we can't cover the batch.
  const credits = await getCredits();
  const perLead = traceType === "advanced" ? 2 : 1;
  if (credits < pending.length * perLead) {
    throw new InsufficientCreditsError(credits, pending.length * perLead, pending.length);
  }

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

  const { rows } = await getTraceResults(queueId, { expectedRows: rowsUploaded });

  // Map results back to contacts by normalized address+city+state (no zip in CSV).
  const resultByKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.matched && r.phone) resultByKey.set(matchKey(r.address, r.city, r.state), r);
  }

  let matched = 0;
  let noMatch = 0;
  for (const c of pending) {
    const hit = resultByKey.get(matchKey(c.address, c.city, c.state));
    if (hit && hit.phone) {
      await setTraceResult(c.id, { phone: hit.phone, phoneType: hit.phoneType, status: "matched" });
      matched++;
    } else {
      // Fail closed: no match => suppress so it can never enter the send path.
      await setTraceResult(c.id, { phone: null, phoneType: null, status: "no_match" });
      await markSuppressed(c.id, "no_match");
      noMatch++;
    }
  }

  return { traced: pending.length, matched, noMatch, queueId };
}
