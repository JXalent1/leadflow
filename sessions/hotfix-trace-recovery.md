# Hotfix — recover orphaned trace results + fix the durability bug

## What happened
The dashboard skip-trace of the 475 `pending` contacts ran successfully on Tracerfy
(**queue id `103802`** — 475 rows, **446 matches**, ~446 credits deducted, status done), but a
browser reload killed the serverless function before it wrote results back to the DB. The Tracerfy
job id was only held in memory and never persisted, so the results were orphaned. The DB still shows
those 475 as `skiptrace_status='pending'` with 0 phones. **Re-reading a completed Tracerfy queue does
NOT re-charge** — only a new trace does — so this is recoverable for free.

Verified current DB state: `matched=24, no_match=1, pending=475`; `with_phone=24`; credits ~501.

## Paste into Claude Code

```
Read CLAUDE.md and sessions/hotfix-trace-recovery.md first.

We hit a durability bug and need to (1) recover already-paid trace results WITHOUT re-charging, then
(2) fix the bug so an interrupted run can never strand paid results again. Do NOT call submitTrace /
trigger a new trace anywhere in this task — that would re-charge.

PART 1 — RECOVER (no new trace):
- Write scripts/ingest-trace-queue.ts that takes a Tracerfy queue id and ingests that ALREADY-COMPLETE
  job's results into contacts, reusing the existing field-mapping + matching logic the skiptrace route
  uses (parse via lib/tracerfy getTraceResults / the same row->contact mapping by
  matchKey = UPPER(address)|UPPER(city)|UPPER(state); best-mobile phone pick; title-case as already
  done). For each uploaded row that maps to a contact: write phone/phone_type + skiptrace_status
  ='matched'. For any still-pending contact in that job's input that got no usable mobile: set
  skiptrace_status='no_match' + suppressed=true/suppress_reason='no_match' (fail closed) — same as the
  route. Idempotent (only touch rows still 'pending').
- Call getCredits() BEFORE and AFTER and print both — PROVE the recovery deducted 0 new credits.
- Run it for queue id 103802. Then print the new counts (matched / no_match / pending / with_phone).

PART 2 — FIX the durability bug:
- Persist the Tracerfy trace job id when a trace is submitted (a small trace_jobs table, or a column)
  with its status, so a job can be re-ingested by id after a crash.
- Make POST /api/skiptrace (and the CLI runner) RESUMABLE: on a run, FIRST ingest any
  completed-but-not-yet-ingested job(s), THEN submit a new trace only for contacts still 'pending'.
  A reload/timeout must no longer be able to lose paid-for results.
- Keep it in scope: do NOT change the send path, the scrub compliance logic, or the inbound webhook.
- Re-run npm test + npm run build.

VERIFY + REPORT:
- After recovery, the DB should show ~496 of 500 traced (24 + ~446 matched, the rest no_match),
  with_phone ~470, and credits UNCHANGED by the recovery (still ~501).
- Update status.md + handoff.md (note the bug, the recovery, and the fix) and overview.md (decision:
  persist the trace job id + resumable ingest).
```

## After this
Back to the dashboard: run scrub on the newly-traced matches (the ~446 matched will cost ~446 scrub
credits — you have ~501, so it just fits; if short, it stops cleanly and you top up). Then we do the
Twilio webhook + self-test before any send.
```
