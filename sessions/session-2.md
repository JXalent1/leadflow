# Session 2 — Tracerfy skip-trace + scrub

## Objective
Append mobile phone numbers to the 500 imported contacts via Tracerfy skip-trace, then run the DNC + litigator scrub and hard-suppress every flagged number. This is Module 2 from `modules.md`. It is the first module that spends money (credits) and the first that touches the compliance-critical suppression path — so the **single-record smoke test is the hard gate before any full run**.

## Prerequisites
- `CLAUDE.md` and `handoff.md` read in full (note the driver + dotenv gotchas below).
- Session 1 complete: `contacts` table holds 500 rows, all with `phone` null and `skiptrace_status='pending'`.
- `TRACERFY_API_KEY` is in `.env.local` (gitignored). Confirm before running the smoke test.
- Tracerfy account has credits. Skip trace + scrub each consume credits (~$0.02+/record) — the full 500 is a real spend, the smoke test is one record.

## What exists to build on (Session 1 output — reuse, don't rename)
- `lib/db.ts` exports the `@neondatabase/serverless` `sql` tagged-template client and typed helpers. Relevant here: `markSuppressed(id, reason)` already exists. You will ADD helpers for writing trace results (see below) — additive only, keep existing signatures.
- `contacts` columns already present: `phone`, `phone_type`, `suppressed`, `suppress_reason`, `skiptrace_status` (`pending|matched|no_match`). No schema change needed unless you choose to track a Tracerfy job id (optional, see Design notes).
- Driver gotcha (from `handoff.md`): `neon()` runs **only as a tagged template** (`sql\`...\``) — there is no `.query(string)`. Scripts must load env explicitly: `import { config } from "dotenv"; config({ path: ".env.local" });`.

## Scope for this session
Build (the four files named in `modules.md`):
- `lib/tracerfy.ts` — typed Tracerfy REST client.
- `app/api/skiptrace/route.ts` — POST: trace all `skiptrace_status='pending'` contacts; write results back.
- `app/api/scrub/route.ts` — POST: scrub traced numbers; suppress any flagged.
- `scripts/smoke-tracerfy.ts` — trace + scrub ONE record, print the raw + parsed shape.

Do NOT build in this session:
- Any Twilio / sending code (Session 3) — not even imports.
- Dashboard UI (Session 5) — these are API/script endpoints only; the dashboard wires to them later.
- `lib/classify.ts` or SMS templating — those are being built in the **parallel pure-logic session** (`sessions/session-pure-logic.md`). Do not touch them here.

## Tracerfy API — what to confirm against the live docs first
Docs: https://www.tracerfy.com/skip-tracing-api-documentation/ — **read them before coding; confirm exact paths, payload keys, and field names, which take precedence over the summary below.**

Known shape (from research, verify):
- **Auth:** Bearer token in `Authorization` header. Key from `process.env.TRACERFY_API_KEY`.
- **Async / batch model.** You submit a batch, get a job/queue id, then poll for results (or set a webhook — do NOT use webhooks this session; poll). Results may arrive as a CSV download URL or JSON — handle whatever the docs specify.
  - `POST /trace/` (or the documented trace path) — submit a batch trace job → returns a queue/job id.
  - `GET /queue/:id` (and/or `GET /queues/`) — poll job status; on completion, fetch results.
  - `POST /dnc/scrub-from-queue/` — scrub the phones from a completed trace queue (preferred — avoids re-uploading phones). `POST /dnc/scrub/` scrubs an explicit phone list.
  - `GET /dnc/queue/:id` — scrub results.
  - `GET /analytics/` — account summary incl. remaining credits.
- **Input format — VERIFY FIRST (highest-risk unknown):** our contacts are **name + situs address** (`first_name,last_name,address,city,state,zip`), NOT parcel IDs / APNs. Confirm the docs' address-based trace input and map our columns to it. If Tracerfy *requires* APNs, STOP and flag it — we'd need a different input and the plan changes.
- **Scrub output:** each phone returns four flags — Federal DNC, State DNC, DMA suppression, known-litigator. Any one set = suppress.

## Detailed specification

### `lib/tracerfy.ts`
- Thin typed client. Read `TRACERFY_API_KEY` from env; throw a clear typed error if missing.
- Functions (adapt names to real payloads):
  - `getCredits()` — GET analytics; returns remaining credits. Used as a pre-flight guard.
  - `submitTrace(records)` — POST trace batch; returns `{ queueId }`. `records` mapped from contacts (name + address).
  - `getTraceResults(queueId)` — poll until complete (bounded: sane interval + max attempts/timeout); returns parsed rows `{ inputRef, phone, phoneType, matched }`. Keep a stable way to map each result row back to its `contact_id` (e.g., pass the contact id as an external reference / row key in the submit, or match on address+zip).
  - `submitScrub(queueId | phones)` — POST scrub (prefer scrub-from-queue); returns `{ scrubQueueId }`.
  - `getScrubResults(scrubQueueId)` — poll; returns per-phone `{ phone, federalDnc, stateDnc, dma, litigator }`.
- **Error handling (CLAUDE.md rule):** wrap every external call in try/catch with logged, typed errors. Never throw a raw fetch error up to the route.

### `app/api/skiptrace/route.ts` (POST)
- Accept optional `{ limit }` in the body (for safe partial runs; smoke/dashboard pass small limits).
- Select contacts WHERE `skiptrace_status='pending'` (so re-runs never re-trace matched/no_match — **idempotent/resumable**).
- Submit trace; poll; for each result: write `phone`, `phone_type`, and set `skiptrace_status='matched'`; for unmatched, set `skiptrace_status='no_match'` AND `suppressed=true, suppress_reason='no_match'` (**fail closed** — never text a no-match).
- Add a small db helper rather than inline scatter, e.g. `setTraceResult(id, { phone, phoneType, status })` in `lib/db.ts` (additive).
- Return a JSON summary: `{ traced, matched, noMatch }`.
- **Serverless-timeout note:** a 500-record poll may exceed Vercel's function limit. Implement the core logic in `lib/tracerfy.ts` so the same functions can run from a CLI; if a full inline run risks timing out, also expose a thin `scripts/run-skiptrace.ts` (optional, allowed) that calls the lib for the real 500 batch. The route still works for small limits.

### `app/api/scrub/route.ts` (POST)
- Run on contacts that are `skiptrace_status='matched'` and have a `phone` and are not already suppressed.
- Submit scrub (prefer scrub-from-queue against the trace job); poll; for any phone with ANY flag set → `markSuppressed(contactId, reason)` where reason ∈ `'dnc' | 'litigator'` (use `'litigator'` if the litigator flag is set, else `'dnc'` for any DNC/DMA flag).
- **Fail closed:** if a phone's scrub result is missing, errored, or ambiguous → suppress it (`suppress_reason='dnc'` or a clear `'scrub_error'`). Never leave an unverified number eligible.
- Return `{ scrubbed, suppressed, byReason }`.

### `scripts/smoke-tracerfy.ts` — the hard gate
- Loads `.env.local` via dotenv.
- Takes ONE real contact (e.g., first `pending`), runs the full trace → scrub round-trip against the live API.
- Prints: the raw API responses AND the parsed shape, plus what it WOULD write (do not require a full DB write, but a single write is fine).
- Purpose: prove the request/response shape and field names are right before spending credits on 500. Runnable via `npx tsx scripts/smoke-tracerfy.ts` (or an `npm run smoke:tracerfy` script).

## Design notes / decisions to make (and record)
- **Result→contact mapping:** decide how trace results map back to `contact_id` (external row reference vs address+zip match). Record the choice in `overview.md` Key Decisions.
- **Job id tracking:** optional — you may store the trace queue id (e.g., in `campaign_runs.note` or a tiny `trace_jobs` table) for resumability. Keep it minimal; don't over-build.
- **Credits guard:** call `getCredits()` before a full run; if insufficient for the pending count, stop and report rather than partially trace.

## Constraints
- No file exceeds 500 lines.
- Secrets only via env; never log the full API key.
- Do not run the full 500 until the smoke test passes and you've confirmed credit balance.
- Stay in scope: no Twilio, no classifier, no templating, no dashboard.
- Suppression is load-bearing: a no-match or any scrub flag MUST result in `suppressed=true`. Fail closed on every uncertainty.

## Acceptance
- Smoke test passes on one record: trace returns a phone (or a clean no-match), scrub returns the four flags, parsed shapes match the code.
- After a run, `contacts` have `phone`/`phone_type` where matched; `skiptrace_status` is `matched`/`no_match` for every processed row; every no-match and every DNC/litigator-flagged contact is `suppressed=true` with a `suppress_reason`.
- Re-running skiptrace traces zero already-matched contacts (idempotent).
- `npm run build` passes.
- `status.md` updated (Session 2 → Completed, deviations noted), `handoff.md` rewritten for Session 3, `modules.md` Module 2 → Done. Record any key decision in `overview.md`.

## Open questions
- Address-based vs APN trace input (verify in docs — highest risk).
- Whether to persist the Tracerfy job id for resumability (minimal if so).
