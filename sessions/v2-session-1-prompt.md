# v2 Session 1 — Multi-tenant foundation

Paste into **Claude Code** (project root). Full plan: `modules-v2.md`. This is the load-bearing
data-model refactor: introduce clients, scope EVERYTHING by client, migrate Talan in as client #1.
After it passes, run the review pass (bottom of this file). Single focused session.

## Goal
Turn the single-client app into a multi-tenant one **without changing any behavior for Talan**. When
done, Talan is "client 1," the dashboard/inbox/campaign all work exactly as before, and adding a
hypothetical client 2 would be fully isolated (no data, suppression, or replies ever cross clients).

## Scope — do this
1. **Schema (`db/schema.sql`, idempotent):**
   - New `clients` table: `id`, `name`, `status` ('active'|'paused', default 'active'),
     `plan_amount_cents` (default 250000), `lead_guarantee` (default 50), `billing_day`,
     and per-client **config**: `from_number`, `messaging_service_sid` (nullable), `biz_name`
     (nullable — Talan's is null since the copy carries no brand), `message_template` (the approved
     copy with [NAME]/[ADDRESS] placeholders), `forward_phone`, `send_window_start_hour`,
     `send_window_end_hour`, `send_timezone`, `send_rate_per_hour`, `optout_confirmation`,
     plus `branding` (logo/colors — JSON or columns), `created_at`.
   - Add `client_id int NOT NULL REFERENCES clients(id)` to **every** data table: `contacts`,
     `messages`, `opt_outs`, `leads`, `campaign_runs`, `trace_jobs`, `scrub_jobs`. Index `client_id`
     on each. Make the existing unique indexes **per-client** where relevant (e.g.
     `opt_outs(client_id, phone)`, `messages(client_id, twilio_sid)`).
2. **Migration:** create client #1 = Talan (name "Talan Window Cleaning", `biz_name` NULL,
   `from_number` +18508213720, the approved `message_template`, `forward_phone`, send window
   10–19 `America/New_York`, `send_rate_per_hour` current value, `optout_confirmation` =
   "You're unsubscribed and will receive no more messages. Reply HELP for help.", lead_guarantee 50,
   plan 250000). Backfill `client_id = 1` on all existing rows. Apply via `npm run schema`.
3. **Config moves from env → the client record.** Per-client values (`from_number`, `biz_name`,
   `message_template`, `forward_phone`, `send_window_*`, `send_timezone`, `send_rate_per_hour`,
   `optout_confirmation`) now come from the client row, NOT env. Keep account-level secrets in env
   (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TRACERFY_API_KEY`, `DATABASE_URL`, `ADMIN_PASSWORD`).
   `renderMessage` should take the client's template; `sendOne` uses the client's sender; the webhook
   uses the client's `optout_confirmation`.
4. **Scope EVERY query by client_id.** Add a `clientId` argument to every helper in `lib/db.ts`,
   `lib/inbox-db.ts`, `lib/scrub.ts`/`lib/skiptrace.ts` selectors, etc. (`getEligibleContacts`,
   `getContactsForScrub`, `getContactsForSkiptrace`, `findContactByPhone`, `getInboxThreads`,
   `getThread`, `getContactById`, `getDashboardData`, every count/insert/update). Filter by
   `client_id` in the WHERE and set it on every INSERT. **No query may read or write across clients.**
5. **Resolve the "current client" per request:**
   - Operator routes (`/api/{skiptrace,scrub,campaign,dashboard,inbox,reply,leads}` + the
     dashboard/inbox pages): take a `clientId` (query param or a selected-client cookie). For now,
     **default to client 1** (Talan is the only client) — a full client switcher UI comes in a later
     module. Admin gate unchanged.
   - **Inbound webhook** (`/api/webhook/twilio`): determine the client by the **`To` number** (the
     Twilio number the message came in on → look up the client whose `from_number`/messaging service
     matches). Scope the contact lookup, suppression, opt-out, lead, and forward to THAT client.
     Reject/ignore if no client owns the number.

## Do NOT
- Change Talan's behavior or copy. After this, his dashboard/campaign/inbox must work identically.
- Build the client-management UI, the client switcher, billing, or client logins (later modules).
- Touch the compliance LOGIC (scrub fail-closed, STOP suppression, signature validation) — only add
  client scoping around it. Per-client suppression/opt-outs must stay airtight.
- Create files over 500 lines (split as needed).

## Acceptance
- `npm run schema` applies; `clients` has Talan as id 1; every data table has `client_id` (all
  existing rows = 1). `npm run build` + `npm test` pass.
- The Talan dashboard (client 1) shows the same numbers as before (500/441/91/etc.).
- A fixture proving **isolation**: insert a client 2 with its own contact + opt_out; confirm client
  1's `getEligibleContacts`/`getInboxThreads`/suppression never return client 2's rows and vice
  versa; an inbound to client 2's number never touches client 1's data.
- Config is read from the client record, not env (a fixture changing client 1's `message_template`
  changes what `renderMessage` produces for client 1 only).
- Update `status.md`, `handoff.md`, `modules-v2.md` (V1 → done), and record decisions in `overview.md`.

## After it passes → review pass (client isolation is the load-bearing guarantee)
Run an agent-team review (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): 3 reviewers —
**isolation** (can any query/route read or write across clients? is every helper scoped? does the
webhook route strictly by To→client?), **compliance** (is per-client suppression/opt-out/eligibility
still airtight; STOP still honored; signature still validated), **correctness** (migration correct,
Talan unchanged, indexes per-client, no N+1/regressions). Fix Critical/High, re-verify build+tests+the
isolation fixture.
