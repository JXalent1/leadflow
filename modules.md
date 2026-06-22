# Modules

_Last updated: 2026-06-22_

The build, broken into sequential modules. Each module = one session = one focused prompt.

## Build order

| # | Module | Status | Depends on |
|---|--------|--------|------------|
| 1 | Scaffold + data model + DB | Not started | — |
| 2 | Tracerfy skip-trace + scrub | Not started | 1 |
| 3 | Twilio send engine (paced) + suppression | Not started | 1, 2 |
| 4 | Inbound webhook: STOP + triage + forward | Not started | 1, 3 |
| 5 | Dashboard UI | Not started | 1, 2, 3, 4 |
| 6 | Deploy to Vercel + pilot run | Not started | all |

## Module details

### 1. Scaffold + data model + DB
**Purpose:** Stand up the Next.js app, the database schema, and the CSV import so contacts are queryable.
**Scope:**
- Next.js + TypeScript + Tailwind project init, deployable skeleton.
- DB schema: `contacts`, `messages`, `opt_outs`, `leads`, `campaign_runs`.
- CSV importer that loads `data/tallahassee_test_500.csv` into `contacts` (name, address, city, state, zip; phone null until Session 2).
- Simple admin gate (single password from env).
**Out of scope for this module:**
- Any Tracerfy / Twilio calls.
- Dashboard visuals beyond a stub page.
**Files it'll create or touch:**
- `db/schema.sql`, `lib/db.ts`, `app/page.tsx`, `scripts/import-csv.ts`, `.env.example`
**Acceptance:** Running the import populates `contacts` with 500 rows; a stub page loads behind the admin gate; app deploys locally.

### 2. Tracerfy skip-trace + scrub
**Purpose:** Append mobile numbers to contacts and mark which numbers are suppressed (DNC/litigator).
**Scope:**
- `lib/tracerfy.ts`: batch skip-trace client (Bearer auth, credit-based) per the API docs.
- `/api/skiptrace`: kick off trace for all contacts lacking a phone; write results back.
- `/api/scrub`: run DNC + state DNC + DMA + litigator scrub on traced numbers; set `contacts.suppressed = true` + reason for any flag.
- Smoke test: trace + scrub ONE record, verify shape.
**Out of scope for this module:**
- Sending anything.
- UI (dashboard reads this data in Session 5).
**Files:** `lib/tracerfy.ts`, `app/api/skiptrace/route.ts`, `app/api/scrub/route.ts`, `scripts/smoke-tracerfy.ts`
**Acceptance:** After running, contacts have phones where matched; every DNC/litigator-flagged contact is `suppressed=true`; smoke test passes on one record.

### 3. Twilio send engine (paced) + suppression
**Purpose:** Send the campaign SMS to eligible contacts only, paced, idempotently.
**Scope:**
- `lib/twilio.ts`: send helper, message templating, pacing (configurable rate, e.g., 50–75/hr).
- `/api/campaign` POST: select contacts WHERE phone IS NOT NULL AND suppressed=false AND not already sent; send paced; log to `messages`; mark send state.
- `/api/campaign` GET: progress (sent, pending, failed, opted-out).
- Message copy from approved variant(s); single segment; includes opt-out language.
- Smoke test: send ONE message to Jordan's own phone before any real send.
**Out of scope for this module:**
- Inbound handling (Session 4).
- Number rotation.
**Files:** `lib/twilio.ts`, `app/api/campaign/route.ts`, `scripts/smoke-twilio.ts`
**Acceptance:** Smoke send works; a dry-run reports correct eligible count; suppressed/opted-out/already-sent contacts are never selected; full send is resumable without double-texting.

### 4. Inbound webhook: STOP + triage + forward
**Purpose:** Handle replies — honor opt-outs instantly, classify interest, forward hot leads to Talan.
**Scope:**
- `/api/webhook/twilio` POST: receive inbound SMS.
- STOP/UNSUBSCRIBE/etc. → write `opt_outs`, set contact suppressed, send confirmation, never text again.
- `lib/classify.ts`: classify reply as interested / not / neutral (keyword + simple heuristic for MVP).
- `lib/forward.ts`: on interest, create a `leads` row and forward to Talan (SMS via Twilio, optional email via Resend) with name, address, and the reply text.
- Log every inbound to `messages`.
**Out of scope for this module:**
- Full AI back-and-forth conversation (later module).
- Dashboard (Session 5).
**Files:** `app/api/webhook/twilio/route.ts`, `lib/classify.ts`, `lib/forward.ts`
**Acceptance:** A STOP reply suppresses instantly + confirms; an interested reply creates a lead and forwards to Talan; all inbound logged.

### 5. Dashboard UI
**Purpose:** One screen to watch the campaign: status counts, send progress, live reply feed, leads, opt-outs.
**Scope:**
- `/dashboard`: cards for sent/pending/delivered/replied/opted-out/leads; send progress bar; reply feed (most recent); leads table (name, address, reply, forwarded status); buttons to trigger skip trace, scrub, and start/pause send.
- Reads from the APIs built in 2–4. Minimal Tailwind, functional over pretty.
**Out of scope for this module:**
- New backend logic — this module only surfaces existing data + triggers existing endpoints.
**Files:** `app/dashboard/page.tsx`, small `components/*`
**Acceptance:** Dashboard shows live counts and the reply/lead feeds; control buttons invoke the right endpoints.

### 6. Deploy to Vercel + pilot run
**Purpose:** Ship it and run the real 500 pilot end to end.
**Scope:**
- Vercel project, env vars set, DB connected, Twilio inbound webhook URL pointed at the deployed `/api/webhook/twilio`.
- Run order on real data: import → skip trace → scrub → smoke send (own phone) → paced full send → watch dashboard.
- Capture the four metrics: delivery, reply, positive-reply, opt-out.
**Out of scope for this module:**
- Scaling features.
**Files:** `vercel.json` (if needed), deployment notes in `status.md`.
**Acceptance:** App live on Vercel; inbound webhook receiving; pilot sent to the eligible subset of the 500; metrics captured.
