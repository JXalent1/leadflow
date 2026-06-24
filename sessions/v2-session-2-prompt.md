# v2 Session 2 — Campaigns + list uploader

Module V2 in `modules-v2.md`. Builds on the multi-tenant foundation (V1). Single focused session.

## Goal
Let each client run **many campaigns over time**, and let the operator **drop in a new CSV list and
go** — no more scripts. A campaign = its own list + its own trace → scrub → send lifecycle.
Suppression stays **client-level**: a person who opts out is never texted by *any* of that client's
campaigns, current or future.

## Scope — do this
1. **Schema (`db/schema.sql`, idempotent):**
   - New `campaigns` table: `id`, `client_id NOT NULL REFERENCES clients(id)`, `name`,
     `status` ('draft'|'ready'|'tracing'|'scrubbing'|'sending'|'done'|'paused', default 'draft'),
     `message_template` (nullable — inherits the client's template when null), `created_at`.
   - Add `campaign_id int NOT NULL REFERENCES campaigns(id)` to `contacts` and `campaign_runs`
     (index it). A contact belongs to one campaign (and thus one client).
   - **Migrate:** create campaign #1 = "Tallahassee pilot" under client 1; backfill all existing
     `contacts` + `campaign_runs` to campaign 1. Apply via `npm run schema`.
2. **CSV uploader (operator UI):**
   - A page/control to upload a CSV for the selected client → creates a NEW campaign and imports its
     contacts (columns `FirstName, LastName, Address, City, State, Zip`). Parse + validate; dedupe
     within the upload (address+zip). Print an import summary (read / imported / skipped). This
     replaces the `scripts/import-csv.ts` flow for the product (keep the script if handy, but the
     uploader is the real path).
3. **Scope the pipeline by campaign:** trace / scrub / send / eligibility / dashboard operate on the
   **selected campaign** (`client_id` + `campaign_id`). A send targets exactly one campaign's contacts.
   - **Suppression stays CLIENT-level by phone (load-bearing):** eligibility for ANY campaign must
     exclude any phone in that client's `opt_outs` — not just the contact row's own `suppressed`
     flag. So if the same person appears in a later campaign, they're still excluded. Add this to the
     eligibility query.
4. **Operator UI:** a campaign selector (pick or create a campaign for the current client) + per-
   campaign progress/counts on the dashboard.

## Do NOT
- Build the operator cockpit (V4), client logins / access control (V5), billing (V6), or the UX
  redesign (V7).
- Touch the compliance LOGIC — only scope it to client+campaign and keep suppression client-level.
- Change client-1 / campaign-1 (Talan pilot) behavior. No source file over 500 lines.

## Acceptance
- `campaigns` exists; the pilot is campaign 1 under client 1; contacts + campaign_runs backfilled.
  `npm run schema` + `npm run build` + `npm test` + `npm run test:isolation` all green; Talan
  unchanged.
- Uploading a CSV creates a new campaign and imports its contacts under the right client; the
  pipeline runs on that campaign only.
- **Fixture proving client-level suppression:** a phone in the client's `opt_outs` is excluded from a
  brand-new campaign's eligibility (even though it's a fresh contact row).
- The dashboard shows per-campaign numbers and the campaign selector works.
- Update `status.md`, `overview.md` (decisions), `modules-v2.md` (V2 → done), and rewrite
  `handoff.md` for V3.

## After it passes → focused review
This touches eligibility/suppression, so run a review of the **client-level-suppression-by-phone** +
campaign scoping (a 3-lens agent team like V1, or a single careful reviewer — your call). The
load-bearing check: no campaign can ever text a phone the client has opted out, and no campaign reads
another client's contacts.
