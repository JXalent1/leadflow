# Modules

_Last updated: 2026-06-23_

The build, broken into modules. Mostly a sequential spine; a couple of pure-logic pieces are
pulled out to run in parallel (see "Parallelization" below).

## Build order

| # | Module | Status | Depends on |
|---|--------|--------|------------|
| 1 | Scaffold + data model + DB | ✅ Done (2026-06-22) | — |
| 2 | Tracerfy skip-trace + scrub | ✅ Done (2026-06-22) — smoke gate passed live (record #1: trace match + scrub `dnc` suppression verified). **Full 500 run intentionally deferred to pilot time (build-first).** | 1 |
| P | Pure logic: `lib/classify.ts` + `lib/sms.ts` + tests (parallel, agent-team) | ✅ Done (2026-06-22, agent team, 124 tests green) | 1 |
| 3 | Twilio send engine (paced) + suppression + `scrub_status` guard | ✅ Done (2026-06-22) — smoke gate passed live (status `delivered`); **agent-team review pass complete** (Critical auth gap + High fixes applied & re-verified: route auth, concurrent-run guard, window re-check, A/B attempt-index, overflow drain, in_flight visibility). | 1, 2, P |
| 4 | Inbound webhook: STOP + triage + forward | ✅ Done (2026-06-22) — built + **agent-team review pass complete** (1 Critical + 1 High fixed & re-verified: STOP-suppression retry-recovery + `opt_outs` uniqueness; cheap `\D`-regex + webhook-URL-warning fixes). 138 unit tests green; signature gate proven via `npm run smoke:webhook` (valid accepted, forged/tampered/wrong-URL/missing → 403); crash-window recovery + exactly-one-confirmation verified. | 1, 3, P |
| 5 | Dashboard UI (+ `SEND_TIMEZONE`→ET one-liner) | ✅ Done (2026-06-22) — admin-gated `/dashboard`: count cards, send-progress bar, reply feed, **leads table (Talan's primary view)**, opt-out list, and control buttons (skip-trace / scrub / dry-run / confirm-gated start-send) over the existing endpoints. Read-only `GET /api/dashboard` aggregator + polling. Task 0 (`SEND_TIMEZONE`→`America/New_York`) applied. `npm run build` + 139 tests green. **No new backend mutation logic; no review team.** | 1, 2, 3, 4 |
| 7 | **Inbox + reply + lead tracking** (added 2026-06-22 — needed before launch) | ✅ Done (2026-06-23) — `/inbox` conversation list + per-contact thread; admin-gated `POST /api/reply` reply box (stored-phone-only, **refuses suppressed/opted-out**, logged) + `POST /api/leads` status/notes; `leads.status`/`notes` schema applied. Build + 153 tests green; suppression refusal proven over live HTTP (422) + DB fixture + unit tests. **Agent-team review COMPLETE (2026-06-23): both adversarial claims HOLD, no Critical; 2 High applied (inbox ordering H1 + `needs_reply` H3) + re-verified; H2 reply-idempotency + Medium/Low logged.** | 1–5 |
| 6 | Deploy to Vercel + pilot run | Runbook ready (`sessions/session-6.md`, `-prompt.md`) — Task 0 copy locked ✅; Phase A deploy + self-test; gate checklist; Phase B live pilot send. **Now waits on Module 7** so the inbox ships with the pilot. | all incl. 7 |

## Parallelization
- **Spine (sequential, single-session each):** 1 → 2 → 3 → 4 → 5 → 6. These share `lib/db.ts` and
  the suppression/send path, so they are NOT parallelized.
- **Module P (✅ done — built parallel to Module 2 by an agent team):** the reply classifier
  (`lib/classify.ts`: `isOptOut`, `classifyInterest`, formerly part of M4) and SMS message
  templating (`lib/sms.ts`: `renderMessage`, `isNonHumanName`, `segmentInfo`,
  `withinSingleSegment`, formerly part of M3) are pure functions with no external dependencies.
  Built in one Claude Code session running an **agent team** (lead + 2 Sonnet teammates, one file
  each, lead ran the compliance review). 124 unit tests via `node:test`/`tsx` (`npm test`);
  `npm run build` passes. **M3 and M4 now import these — do NOT rebuild them.**
- **Review (parallel, agent-team):** M3 (send path) and M4 (STOP/suppression) get a parallel
  security/compliance review pass after they're built — multiple independent reviewers on the
  load-bearing compliance code.

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
- _Also created:_ `app/layout.tsx`, `app/globals.css`, `app/actions.ts` (gate server actions), `scripts/apply-schema.ts`, project config (`package.json`, `tsconfig.json`, `next.config.js`, `tailwind.config.ts`, `postcss.config.js`, `.gitignore`).
**Acceptance:** ✅ Met — import populated `contacts` with 500 rows; stub page loads behind the admin gate (verified in headless browser); `npm run build` + `npm run dev` work locally.

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
- `lib/twilio.ts`: send helper + pacing (configurable rate, e.g., 50–75/hr). **Message templating is already built in Module P (`lib/sms.ts`) — import `renderMessage`/`withinSingleSegment`, do not rebuild.**
- **Adds the `scrub_status` guard** (column + scrub writes it + eligibility requires `scrub_status='clean'`) so the send can never reach an unscrubbed contact.
- `/api/campaign` POST: select contacts WHERE phone IS NOT NULL AND suppressed=false AND scrub_status='clean' AND not already sent; send paced; log to `messages`; mark send state. Requires `confirm:true` + send-window for a real run.
- `/api/campaign` GET: progress (sent, pending, failed, opted-out).
- Message copy from approved variant(s); single segment; includes opt-out language.
- Smoke test: send ONE message to Jordan's own phone before any real send.
**Out of scope for this module:**
- Inbound handling (Session 4).
- Number rotation.
**Files:** `lib/twilio.ts`, `app/api/campaign/route.ts`, `scripts/smoke-twilio.ts`
**Acceptance:** ✅ Met — smoke send delivered one SMS to Jordan's phone via `renderMessage` (single GSM-7 segment, opt-out line present, SID `SM5a038a…40063`, status `delivered`); fixture proved only `phone NOT NULL AND suppressed=false AND scrub_status='clean' AND send_status='not_sent'` rows are selected (pending-scrub / suppressed / already-sent / no-phone all excluded), and the atomic claim makes a re-run never re-text (second claim of the same row returns false; a claimed row drops out of eligible). Real send refuses without `confirm:true` and outside the send window. `npm run build` + 124 unit tests pass.

### 4. Inbound webhook: STOP + triage + forward
**Purpose:** Handle replies — honor opt-outs instantly, classify interest, forward hot leads to Talan.
**Scope:**
- `/api/webhook/twilio` POST: receive inbound SMS.
- STOP/UNSUBSCRIBE/etc. → write `opt_outs`, set contact suppressed, send confirmation, never text again.
- Reply classification + opt-out detection are already built in Module P (`lib/classify.ts`: `classifyInterest`, `isOptOut`) — import them, do not rebuild. This module wires them to the DB + confirmation flow.
- `lib/forward.ts`: on interest, create a `leads` row (the dashboard's source) and send a one-line **SMS ping** to Talan (`TALAN_FORWARD_PHONE`) with name, address, and the reply text. **SMS only — no email/Resend** (dropped 2026-06-22). Webhook validates the **Twilio signature** as its auth.
- Log every inbound to `messages`.
**Out of scope for this module:**
- Full AI back-and-forth conversation (later module).
- Dashboard (Session 5).
**Files:** `app/api/webhook/twilio/route.ts`, `lib/forward.ts`, `lib/inbound.ts` (decision core, consumes `lib/classify.ts` from Module P), `lib/inbound.test.ts`, `scripts/smoke-webhook.ts`. Additive `lib/db.ts` helpers: `findContactByPhone`, `recordOptOut`, `markLeadForwarded`, `logInboundOnce`.
**Acceptance:** ✅ Met — STOP (even mixed with interest words) → opt_out row + `suppressed=true`/`suppress_reason='opt_out'` + one TwiML confirmation, never a lead; interested reply → lead row + one SMS ping to Talan (`forwarded=true`/`forwarded_at`; a failed ping leaves the lead with `forwarded=false`); not-interested/neutral → logged only; orphan inbound → logged, no crash; duplicate MessageSid → processed once (no double opt-out/lead/forward); forged/missing-signature request → 403 before any DB write. 13 inbound unit tests + `npm run smoke:webhook` (signature gate) + `npm run build` all pass.
**Deviation:** added `lib/inbound.ts` (decision core extracted from the route so STOP-precedence / idempotency / classification routing are unit-testable with injected fakes — no DB/Twilio needed) and a partial UNIQUE index on `messages(twilio_sid)` (the atomic idempotency gate). STOP confirmation sent via **TwiML `<Message>`** (one send, no extra API call); `TWILIO_ADVANCED_OPT_OUT=true` suppresses it if Twilio's Advanced Opt-Out is ever enabled (avoids double-confirm).

### 5. Dashboard UI
**Purpose:** One screen to watch the campaign: status counts, send progress, live reply feed, leads, opt-outs.
**Scope:**
- `/dashboard`: cards for sent/pending/delivered/replied/opted-out/leads; send progress bar; reply feed (most recent); **leads table — the primary surface for Talan** (name, address, reply, ping status); buttons to trigger skip trace, scrub, dry-run, and a **confirm-gated** start send.
- Reads from the APIs built in 2–4. Minimal Tailwind, functional over pretty. Also applies the `SEND_TIMEZONE`→`America/New_York` carry-over (Task 0). **No agent-team review pass** (no new backend logic).
**Out of scope for this module:**
- New backend logic — this module only surfaces existing data + triggers existing endpoints.
**Files:** `app/dashboard/page.tsx` (server component, admin gate), `app/api/dashboard/route.ts` (read-only aggregated GET for polling), `lib/dashboard.ts` (read-only aggregator shared by both), `components/*` (`dashboard-client`, `count-cards`, `send-progress`, `campaign-controls`, `leads-table`, `reply-feed`, `opt-out-list`, `dashboard-utils`). Additive read-only `lib/db.ts` helpers: `getDashboardExtraCounts`, `getRecentLeads`, `getRecentInbound`, `getRecentOptOuts` (+ `LeadRow`/`InboundRow`/`OptOutRow` types).
**Acceptance:** ✅ Met — unauthed `/dashboard` → 307 to `/` login; unauthed `GET /api/dashboard` → 401; authed renders all sections + live counts (verified: 500 total, 0 eligible since trace/scrub deferred). Dry-run returns eligible + per-variant split and sends nothing; real send without `confirm:true` → 400 `confirmation_required` (UI requires a typed CONFIRM before sending `confirm:true`, and disables the send button outside the window / while a run is active). `npm run build` registers `ƒ /dashboard` + `ƒ /api/dashboard`; 139 unit tests green.
**Deviation:** added a read-only `GET /api/dashboard` + `lib/dashboard.ts` aggregator (not in the scope file's exact file list) so the server-component initial render and the client polling share ONE data shape — it only reads (no mutation). Inbound `disposition` tags are derived on the fly from the pure `lib/classify.ts` (no stored column, no side effect). Send model = "run batch / continue" (no pause endpoint; the send is resumable).

### 7. Inbox + reply + lead tracking (build BEFORE the live pilot send)
**Purpose:** Make the dashboard a workspace — see each homeowner's full conversation, reply to them from the campaign number inside the app, and track lead status. Closes the "what happens after they say yes" gap (the prior design only pinged Talan; there was no in-app reply).
**Scope:**
- Inbox `/inbox` (admin-gated): conversation list (needs-reply badge, suppressed marked) + per-contact thread (from `messages`).
- **Reply box** → new `POST /api/reply` (admin-gated): texts back via `sendOne` to the **stored contact phone only**, **refuses any suppressed/opted-out contact**, logs the outbound. (Not blocked by the campaign send window; suppression is the gate.)
- Lead tracking: `leads.status` (new/contacted/quoted/scheduled/won/lost) + `leads.notes`; `POST /api/leads` to update; shown on the dashboard.
**Out of scope:** AI/auto replies, bulk replies, any new cold-send path.
**Files:** `app/api/reply/route.ts`, `app/api/leads/route.ts`, `app/api/inbox/route.ts` (read-only GET for client refresh), `app/inbox/page.tsx`, `components/inbox/*` (`inbox-client`, `conversation-list`, `thread-view`, `reply-box`, `lead-status`), `components/leads-table.tsx` (status column + thread link), `app/dashboard/page.tsx` (Inbox link), `db/schema.sql` (status/notes), `lib/inbox-db.ts` (Module-7 DB helpers, split out of `lib/db.ts` to stay ≤500 lines), `lib/reply.ts` (pure suppression gate `replyRefusalReason`), `lib/lead-status.ts` (funnel values, pure so client can import), `lib/reply.test.ts`.
**Acceptance:** ✅ Met — `/inbox` lists conversations (needs-reply badge, suppressed marked + reply box disabled); opening one shows the full thread (inbound/outbound distinct) with reply box + lead status dropdown/notes; reply sends from the campaign number to the **stored phone only** and logs to `messages`; **reply to a suppressed/opted-out contact is refused (live HTTP returns 422 `recipient_suppressed`, `sendOne` never called; UI box disabled)**; lead status/notes update (`POST /api/leads`, status validated) and show on the dashboard leads table. Every new endpoint admin-gated (401/307 unauthed, verified). `npm run build` + 153 unit tests green; all files ≤500 lines. **Agent-team review COMPLETE (2026-06-23):** 3 read-only reviewers (security/compliance/correctness) — no Critical; both adversarial claims HOLD (no arbitrary-number send; the dual `suppressed`+`opt_outs` check blocks every opted-out path). Applied 2 High in `lib/inbox-db.ts` (H1 inbox-list ordering fallback to the lead's `created_at`; H3 `needs_reply` excludes suppressed contacts) + re-verified (153 tests, build, DB fixture). H2 (no server-side reply idempotency → at worst a duplicate to a non-suppressed person) + Mediums/Lows + the inherent TOCTOU race logged as accepted MVP limitations.
**Deviation:** (1) added a read-only `GET /api/inbox` (list + `?contactId=` thread) so the client can refresh after a reply without a full page reload — reads only. (2) split the Module-7 DB helpers into `lib/inbox-db.ts` (the additions pushed `lib/db.ts` past the 500-line cap). (3) extracted the suppression decision into a pure `lib/reply.ts` (`replyRefusalReason`) so it's unit-testable without a DB/Twilio and is the single source of the gate; the route calls it. (4) `LEAD_STATUSES` lives in a pure `lib/lead-status.ts` so the client dropdown imports it without bundling the Neon driver. (5) send-window "off hours" is a soft UI hint computed server-side and passed down (replies are intentionally NOT window-blocked).

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
