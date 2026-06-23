// lib/scrub.ts — one batch of DNC + litigator scrubbing (shared by the API route
// and the CLI runner so the fail-closed compliance logic exists in exactly one place).
//
// Runs on contacts that are matched, have a phone, and are not yet suppressed.
// Fail closed (load-bearing for compliance): a phone is left eligible ONLY if the
// scrub result explicitly marks it clean. Missing, ambiguous, or any-flag => suppress.

import { getContactsForScrub, markSuppressed, setScrubStatus } from "@/lib/db";
import {
  submitScrub,
  getScrubResults,
  normalizePhone,
  type ScrubResultRow,
} from "@/lib/tracerfy";

export type ScrubReason = "litigator" | "dnc" | "scrub_error";

export interface ScrubBatchResult {
  scrubbed: number;
  clean: number;
  suppressed: number;
  byReason: Record<ScrubReason, number>;
  scrubQueueId?: number;
  note?: string;
}

/**
 * Scrub up to `limit` matched-but-unscrubbed contacts (all if omitted). Suppresses
 * any flagged/ambiguous number and marks scrub_status; only an explicit clean verdict
 * sets scrub_status='clean'. Prefers scrub-from-queue when `traceQueueId` is given.
 */
export async function scrubBatch(
  opts: { limit?: number; traceQueueId?: number; phoneColumns?: string[] } = {}
): Promise<ScrubBatchResult> {
  const contacts = await getContactsForScrub(opts.limit);
  if (contacts.length === 0) {
    return { scrubbed: 0, clean: 0, suppressed: 0, byReason: emptyReasons(), note: "nothing to scrub" };
  }

  // Prefer scrub-from-queue if the trace queue id is supplied; else explicit phones.
  const { scrubQueueId } = opts.traceQueueId
    ? await submitScrub({ queueId: opts.traceQueueId, phoneColumns: opts.phoneColumns })
    : await submitScrub({ phones: contacts.map((c) => normalizePhone(c.phone)) });

  const { byPhone } = await getScrubResults(scrubQueueId);

  const byReason = emptyReasons();
  let suppressed = 0;
  let clean = 0;
  for (const c of contacts) {
    // Guard against a null phone slipping through (the query filters NOT NULL, but
    // the type allows null) — skip rather than crash the whole batch on one bad row.
    if (!c.phone) continue;
    const row = byPhone.get(normalizePhone(c.phone));
    const reason = classify(row);
    if (reason) {
      // Any flag (or fail-closed scrub_error): suppress AND mark scrub_status='flagged'.
      await markSuppressed(c.id, reason);
      await setScrubStatus(c.id, "flagged");
      byReason[reason]++;
      suppressed++;
    } else {
      // Only an explicit clean verdict marks the contact eligible to send.
      await setScrubStatus(c.id, "clean");
      clean++;
    }
  }

  return { scrubbed: contacts.length, clean, suppressed, byReason, scrubQueueId };
}

function emptyReasons(): Record<ScrubReason, number> {
  return { litigator: 0, dnc: 0, scrub_error: 0 };
}

/** Decide suppression reason for a scrub row. null => verified clean, leave eligible. */
export function classify(row: ScrubResultRow | undefined): ScrubReason | null {
  // Missing result => fail closed.
  if (!row) return "scrub_error";
  if (row.litigator) return "litigator";
  if (row.federalDnc || row.stateDnc || row.dma) return "dnc";
  // Only an explicit clean verdict keeps a number eligible.
  if (row.isClean) return null;
  return "scrub_error";
}
