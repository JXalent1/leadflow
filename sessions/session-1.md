# Session 1 — Scaffold + data model + DB

## Objective
Stand up the LeadFlow application skeleton: a deployable Next.js + TypeScript app, the Postgres schema, a CSV importer that loads the 500-record pilot list into the `contacts` table, and a single-password admin gate. This is Module 1 from `modules.md` — the foundation every later module builds on. No external API calls (Tracerfy/Twilio) in this session.

## Prerequisites
- `CLAUDE.md` has been read.
- Previous sessions completed: none (this is session 1).
- DB provider is **decided: Neon Postgres**, provisioned via the Vercel Marketplace integration (driver `@neondatabase/serverless`). Before starting, the Neon database must exist (created from Vercel → Storage → Neon) and its `DATABASE_URL` (plus the `POSTGRES_*`/`DATABASE_URL_UNPOOLED` vars the integration provides) must be in `.env.local`. Note: the old `@vercel/postgres` driver is deprecated — do not use it.
- `data/tallahassee_test_500.csv` exists with columns: `FirstName, LastName, Address, City, State, Zip`.

## Scope for this session
Build:
- Next.js 14+ App Router project in TypeScript with Tailwind configured.
- `db/schema.sql` defining all tables (below).
- `lib/db.ts` — DB client + minimal typed query helpers.
- `scripts/import-csv.ts` — reads the pilot CSV and inserts into `contacts`.
- `app/page.tsx` — admin-gated landing stub (password from `ADMIN_PASSWORD`).
- `.env.example` listing every required env var.

Do NOT build in this session:
- Any Tracerfy or Twilio integration (Sessions 2–3).
- The dashboard UI (Session 5) — a stub page is enough.
- Reply handling or forwarding (Session 4).

## Detailed specification

### Data model (`db/schema.sql`)
Use snake_case. Postgres.

`contacts`
- `id` serial primary key
- `first_name` text
- `last_name` text
- `address` text not null
- `city` text
- `state` text
- `zip` text
- `phone` text null            — populated in Session 2
- `phone_type` text null       — mobile/landline from Tracerfy
- `suppressed` boolean not null default false   — true if DNC/litigator flagged OR opted out
- `suppress_reason` text null  — e.g., 'dnc', 'litigator', 'opt_out', 'no_match'
- `skiptrace_status` text not null default 'pending'  — pending/matched/no_match
- `send_status` text not null default 'not_sent'      — not_sent/sent/failed
- `created_at` timestamptz default now()

`messages`
- `id` serial primary key
- `contact_id` int references contacts(id)
- `direction` text not null     — 'outbound' | 'inbound'
- `body` text not null
- `twilio_sid` text null
- `status` text null            — twilio status callbacks later
- `created_at` timestamptz default now()

`opt_outs`
- `id` serial primary key
- `contact_id` int references contacts(id)
- `phone` text not null
- `created_at` timestamptz default now()

`leads`
- `id` serial primary key
- `contact_id` int references contacts(id)
- `reply_text` text
- `forwarded` boolean not null default false
- `forwarded_at` timestamptz null
- `created_at` timestamptz default now()

`campaign_runs`
- `id` serial primary key
- `started_at` timestamptz default now()
- `total_eligible` int
- `sent_count` int default 0
- `note` text null

Add helpful indexes: `contacts(suppressed)`, `contacts(send_status)`, `contacts(phone)`.

### DB client (`lib/db.ts`)
- Export a configured client using the `@neondatabase/serverless` driver (the decided provider is Neon via the Vercel integration). Use its `neon()` HTTP query function (tagged-template `sql` helper) for queries; reach for the Pool/WebSocket mode only if a real multi-statement transaction is needed. Read the connection string from `process.env.DATABASE_URL`. Do not add a second DB library; do not use the deprecated `@vercel/postgres`.
- Export typed helpers used by later sessions: `getEligibleContacts()`, `insertContact()`, `markSuppressed(id, reason)`, `recordMessage(...)`, `createLead(...)`. Stub the ones not needed yet but define signatures so later sessions don't rename.
- Read connection string from `process.env.DATABASE_URL`.

### CSV importer (`scripts/import-csv.ts`)
- Read `data/tallahassee_test_500.csv` (use a CSV parser, e.g., `csv-parse` or `papaparse`).
- For each row, insert a `contacts` record with phone null, skiptrace_status 'pending'.
- Idempotent: don't duplicate if run twice (e.g., skip if a contact with same address+zip exists, or truncate-then-load behind a `--fresh` flag).
- Log a summary: rows read, inserted, skipped.
- Runnable via `npx tsx scripts/import-csv.ts` (or a package.json script `import`).

### Admin gate (`app/page.tsx`)
- Minimal: a password field; on submit compare to `ADMIN_PASSWORD` (server action or simple API check). Set an httpOnly cookie/session flag.
- Not real auth — just keeps the dashboard from being world-open. One shared password is fine for MVP.
- After auth, show a stub: "LeadFlow — N contacts loaded, M with phones, K suppressed" pulled from the DB. This proves the DB wiring works.

### .env.example
List, with placeholder values and a one-line comment each:
`DATABASE_URL`, `ADMIN_PASSWORD`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TRACERFY_API_KEY`, `TALAN_FORWARD_PHONE`, `RESEND_API_KEY` (optional), `TALAN_FORWARD_EMAIL` (optional).

## Constraints
- No file exceeds 500 lines.
- Secrets only via env, never hardcoded.
- Pick ONE db driver and one CSV parser; don't pull in redundant libs.
- Stay within scope. If something seems needed but isn't in scope (e.g., you want to start the Twilio client), flag it and stop.

## Acceptance
Session is complete when:
- `npm run dev` serves the app; the admin gate works.
- Running the import script populates `contacts` with 500 rows (verify a count query).
- The stub landing page reads and displays the contact/phone/suppressed counts from the DB.
- `.env.example` documents every variable.
- `status.md` updated (Session 1 → Completed) and `handoff.md` rewritten.

## Open questions
- ~~DB provider~~ — resolved: **Neon Postgres** via the Vercel Marketplace integration, driver `@neondatabase/serverless`, recorded in `overview.md` Key Decisions (2026-06-22). (Vercel's old first-party Postgres + `@vercel/postgres` are deprecated.)
- Whether to keep the admin gate as a cookie flag or add a tiny session lib — cookie flag is fine for MVP; don't over-build.
