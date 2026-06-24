# Hotfix — scrub re-billing bug (over-charged + stalled)

## Root cause (confirmed in code)
`getContactsForScrub` (lib/db.ts) selects `skiptrace_status='matched' AND phone IS NOT NULL AND
suppressed=false` — it does **NOT** exclude already-scrubbed contacts. A contact that scrubs **clean**
keeps `suppressed=false`, so the next chunk re-selects and **re-scrubs** it (re-billing at Tracerfy).
Flagged contacts become `suppressed=true` and correctly drop out. Result on the live run: the scrub
re-billed the growing clean pile every chunk (~$5 wasted), the per-chunk "clean" count climbed
(35→91 = the same contacts re-counted), and credits ran out (402) before ~175 high-id contacts were
ever scrubbed. They are genuinely unscrubbed (never billed) — NOT recoverable-for-free, they just
need scrubbing once the leak is fixed.

Verified DB state: scrub_status clean=91, flagged=175, pending=234 (175 with a phone, never scrubbed);
balance ~1 credit.

## Paste into Claude Code

```
Read CLAUDE.md and sessions/hotfix-scrub-rebilling.md first. This is a credit-safety bug in the scrub
path — do NOT run a real scrub until it's fixed, and prove the fix without spending real credits.

PART 1 — fix the re-billing leak (the core bug):
- In lib/db.ts getContactsForScrub: add `AND scrub_status = 'pending'` to BOTH the limited and
  unlimited queries, so already-scrubbed (clean OR flagged) contacts are NEVER re-selected/re-billed.
- Add a unit/fixture check: after a contact is marked scrub_status='clean', getContactsForScrub no
  longer returns it (so a second scrub pass scrubs 0 of the already-clean ones).

PART 2 — credit safety + durability (so a scrub run can never silently waste credits again):
- Add a credit pre-flight to scrubBatch / the scrub route + CLI runner: read getCredits() and the
  count of pending-with-phone; if credits can't cover the pending count, STOP and report
  "need N, have M" BEFORE submitting anything (don't die mid-run on a 402).
- Persist the scrub queue id (a scrub_jobs table, mirroring the trace_jobs fix) and make scrub
  resumable: on a run, re-ingest any orphaned scrub job first (free), then submit only for
  still-pending contacts. Set scrub_status atomically per contact so a crash can't leave a billed
  contact unmarked-and-re-billed.
- Prefer scrub-from-queue when a trace queue id is available (avoids re-uploading phones), but the
  pending-status filter is the load-bearing fix.

KEEP IN SCOPE: do not touch the send path, the inbound webhook, the trace logic, or the fail-closed
classify() verdict logic (clean/flagged decisions are correct — only the SELECTION re-billed).

VERIFY + REPORT (no real credits spent):
- Fixture proof: getContactsForScrub excludes a scrub_status='clean' row; credit pre-flight refuses
  cleanly when balance < pending count.
- npm test + npm run build green; npm run schema applied (scrub_jobs).
- State the exact credit cost to finish the remaining 175 (≈175) so Jordan can top up the right
  amount. Update status.md + handoff.md + overview.md (decision: scrub selects pending-only +
  credit pre-flight).
```

## After the fix
Top up ~$5–10 of Tracerfy credits, then `npm run scrub` finishes the 175 cleanly (~$3.50, no
re-billing) → final eligible ~150. OR launch now with the 91 already-clean contacts and finish the
rest later. Either way the 91 clean are correct and sendable.
```
