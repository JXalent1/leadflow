# Handoff

_For the next session — read this first._

_Last updated: 2026-06-24 (Claude Code — v2 Module V1 BUILT + REVIEW-CLEAN)_

## TL;DR
LeadFlow is a self-hosted SMS lead-gen tool; v1 shipped a live pilot for Talan (Tallahassee window
cleaning, 91 sent). v2 turns it into an agency product ($2,500/mo + 50-leads/mo guarantee per client).
**v2 Module V1 (multi-tenant foundation) is BUILT, green, AND review-clean** — `clients` table,
`client_id` on every table, every query scoped by client, Talan migrated in as **client 1 with ZERO
behavior change**, per-client config moved env→record. The 3-reviewer client-isolation pass found **no
Critical/High**; 5 cheap Medium/Low fixes applied + re-verified. **V1 is done — next is V2.**

## ▶ Immediate next: generate the V2 prompt — campaigns + CSV uploader
Per `modules-v2.md` row **V2**: a `campaigns` table (a client runs many campaigns over time) + a **CSV
uploader** so you drop a list into a client and go (no more scripts). Write `sessions/v2-session-2-*`
one prompt at a time (same cadence as v1), building on the now-multi-tenant-native foundation.

## ⚠ Logged gate before onboarding a 2nd client (from the V1 review — do NOT skip)
`?clientId=` is accepted from any authenticated operator with **no per-client access control**, so once
a 2nd client exists an operator could reach another client's data/sender via `?clientId=N`. It's
**dormant today** (single shared admin password, only client 1 exists → `?clientId=2` returns 404) and
solving it properly IS **module V5** (client logins / scoped access) — so it was deliberately NOT built
in V1. But it is a HARD prerequisite before a real client #2 goes live. (Eligibility/suppression are
still correctly scoped to whatever clientId is supplied — this is an access-control gap, not a
cross-client data leak.)

## V1 review pass — DONE (2026-06-24), no Critical/High
3 read-only reviewers (isolation / compliance / correctness, Sonnet) confirmed the load-bearing claim
HOLDS: no data/suppression crosses a client boundary (both directions), the webhook validates the
signature before resolving the client + routes strictly by `To`→client, migration correct, Talan
byte-unchanged. **Applied:** schema CREATE-then-DROP index order; `import-csv --fresh` client-scoped
(was a global TRUNCATE); `.env.example` timezone fix + per-client-config note; documented
`processInbound`'s client-binding invariant and the `getClientByInboundNumber` from_number-only
limitation. Full findings in `status.md` + `overview.md`.

## What V1 shipped (all verified green)
- **Schema (`db/schema.sql`, applied via `npm run schema`):** new `clients` table (status, plan $,
  lead_guarantee, billing_day, `from_number`/`messaging_service_sid`, `biz_name`, `message_template`,
  `forward_phone`, send window/timezone/rate, `optout_confirmation`, `branding` jsonb). Talan = **client
  1** (verified: biz_name NULL, +18508213720, 10–19 America/New_York, rate 60, guarantee 50, plan
  250000, verbatim template + opt-out copy). `client_id int NOT NULL REFERENCES clients(id)` + index on
  every data table (existing rows backfilled to 1 via `DEFAULT 1`, then default DROPPED). Unique indexes
  now **per-client**: `opt_outs(client_id, phone)`, `messages(client_id, twilio_sid)` (legacy global
  ones dropped).
- **Scoping:** every helper in `lib/db.ts`, `lib/inbox-db.ts`, **new `lib/dashboard-db.ts`**,
  `lib/trace-jobs.ts`, `lib/scrub-jobs.ts`, and the batch libs (`lib/skiptrace traceBatch`,
  `lib/scrub scrubBatch`) takes `clientId` and filters/sets `client_id`. **No query crosses clients.**
- **Current-client resolution:** `lib/request-client.ts` — operator routes/pages default to client 1
  with a `?clientId=` override. The **webhook resolves the client by the `To` number**
  (`lib/clients.ts getClientByInboundNumber`); unknown number → ack + no-op (touches nobody's data).
- **Config env→record (`lib/clients.ts`):** `renderMessage` is now **template-driven** off
  `client.message_template`; `sendOne` takes the client's sender; the send window/rate, lead-forward
  number, and opt-out confirmation all come from the client row. Account-level secrets stay in env
  (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, `TRACERFY_API_KEY`, `DATABASE_URL`, `ADMIN_PASSWORD`).
- **Proof:** `tsc` clean, `npm run build` green, **`npm test` 160 green**, **`npm run test:isolation`
  22/22** (cross-client isolation both directions + webhook To-routing + template-change-affects-one-
  client + client-1-byte-unchanged + fixtures cleaned up). DB confirmed back to 1 client, 0 non-client-1
  rows after the fixture.

## Gotchas the reviewer/next session must know
- **`renderMessage` signature CHANGED:** was `renderMessage(variant, contact, biz)`, now
  `renderMessage(template, contact, bizName?)`. The unused B/C creative variants were dropped (pilot
  always ran `AB_VARIANTS=A`). A `{...}` span in a template is an **optional clause** dropped when it
  would overflow one GSM-7 segment (or a placeholder inside resolves empty) — this reproduces Talan's
  single-segment address fallback. Talan's template lives in `clients.message_template` AND as
  `TALAN_MESSAGE_TEMPLATE` in `lib/sms.ts` (kept in sync for tests; schema seed must match).
- **`client_id` has NO default** (dropped after backfill) — every INSERT must set it. This is
  deliberate: a forgotten `client_id` should fail loudly, not silently land in client 1.
- **apply-schema is naive:** it splits `db/schema.sql` on `;` and strips `--` comments — so **no
  semicolon may appear anywhere, including inside a comment**, and no DO/PL-pgSQL blocks. (This bit us
  this session; fixed.)
- **`forwardLead` falls back to `TALAN_FORWARD_PHONE` env for client 1 ONLY** (Talan's seeded
  `forward_phone` is NULL because the real number is a secret). The fallback is client-1-scoped so it
  can never leak across clients. To fully decouple Talan from env, set client 1's `forward_phone` in the
  DB later.
- **Scripts gained `--client=N` (default 1):** `npm run trace/scrub/ingest/import`. `npm run
  test:isolation` is the isolation fixture.
- **Pre-existing, NOT fixed (out of V1 scope):** `lib/tracerfy.ts` is 536 lines (>500). Untouched this
  session; flag for a later split.
- **Live DB note:** the Neon DB now reflects v2 (clients + client_id everywhere). Talan's data is intact
  and all scoped to client 1 (500 contacts, 101 messages, 5 opt_outs).

## Compliance reminder (unchanged hard requirements)
Never text a scrub-flagged / no-match / opted-out / unscrubbed number; honor STOP instantly +
permanently. V1 only added client *scoping* around the existing compliance LOGIC (fail-closed scrub,
STOP suppression, signature validation) — and now suppression/opt-outs are **per-client** (one client's
opt-out never suppresses or leaks into another's, and never fails to suppress within its own client).
The isolation fixture asserts both directions; keep it green.

## Open questions / pending input (carried from v1, still true)
- Talan's cell (`TALAN_FORWARD_PHONE` / client 1 `forward_phone`) for the lead ping.
- Per-client login vs shared admin password (client logins are module V5).
- Rotate the Twilio token + Tracerfy key after the pilot (shared in chat in plaintext).
