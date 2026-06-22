# Session 1 — kick-start prompt

This is the prompt to paste into **Claude Code** (run in the project root) to build Module 1.
The full spec it executes lives in `sessions/session-1.md`. DB is decided: **Neon Postgres** (via the Vercel Marketplace integration; driver `@neondatabase/serverless`). Note: Vercel's old first-party "Vercel Postgres" and the `@vercel/postgres` driver are deprecated — Neon is the current Postgres-on-Vercel option.

---

## Before you paste this (one-time setup, ~5 min)

You must do these yourself — Claude Code needs them to exist:

1. **Create the Neon database.** In the Vercel dashboard → Storage → under "Marketplace Database Providers" pick **Neon (Serverless Postgres)** → Create. Name it something like `leadflow`, accept the free plan, and connect it to your project.
2. **Grab the connection vars.** After it provisions, open the integration's `.env.local` tab and copy the generated vars (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and the `POSTGRES_*`/`PG*` vars).
3. **Put them in `.env.local`** at the project root. Session 1 also expects `ADMIN_PASSWORD=<pick-anything>` for the admin gate. (`@neondatabase/serverless` reads the connection string from `DATABASE_URL` — make sure that one is set.)
4. Make sure Node 18+ is installed.

You do NOT need Twilio, Tracerfy, or Talan's contact for this session — those come in Sessions 2–4.

---

## The prompt (copy everything in the block below)

```
Read `CLAUDE.md` and `sessions/session-1.md` in full before writing any code.

Your scope for this session is ONLY Module 1: Scaffold + data model + DB. Do NOT:
- Work on any other module.
- Create any file larger than 500 lines.
- Make any Tracerfy or Twilio API calls, or add their SDKs yet.
- Add a second database library — the DB is Neon (via the Vercel integration) using the
  `@neondatabase/serverless` driver ONLY. Do NOT use the deprecated `@vercel/postgres`,
  Supabase, the `postgres` package, or `drizzle`.

Build exactly what `sessions/session-1.md` specifies:
- Next.js 14+ App Router + TypeScript + Tailwind, deployable skeleton.
- `db/schema.sql` with tables: contacts, messages, opt_outs, leads, campaign_runs
  (snake_case, with the indexes the spec lists). Then run it against the Vercel
  Postgres database to create the tables.
- `lib/db.ts` — a `@neondatabase/serverless` client (use `neon(process.env.DATABASE_URL)`
  and its `sql` tagged-template helper) plus the typed helper signatures the spec names
  (getEligibleContacts, insertContact, markSuppressed, recordMessage, createLead). Stub
  the ones not needed yet but define the signatures so later sessions don't rename them.
- `scripts/import-csv.ts` — reads `data/tallahassee_test_500.csv`
  (columns: FirstName, LastName, Address, City, State, Zip) and inserts into
  `contacts` with phone null and skiptrace_status 'pending'. Must be idempotent
  (safe to run twice — no duplicates) and print a summary (read / inserted / skipped).
  Runnable via `npx tsx scripts/import-csv.ts`.
- `app/page.tsx` — minimal admin gate: password field compared to `ADMIN_PASSWORD`,
  httpOnly cookie flag (not real auth). After auth, show a stub reading live counts
  from the DB: "LeadFlow — N contacts loaded, M with phones, K suppressed".
- `.env.example` — document every required env var with a one-line comment each:
  DATABASE_URL (and the POSTGRES_* vars Vercel provides), ADMIN_PASSWORD,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TRACERFY_API_KEY,
  TALAN_FORWARD_PHONE, RESEND_API_KEY (optional), TALAN_FORWARD_EMAIL (optional).

Acceptance (verify before you call this done):
- `npm run dev` serves the app and the admin gate works.
- Running the import populates `contacts` with 500 rows — prove it with a count query.
- The stub landing page reads and displays the contact / phone / suppressed counts.
- `.env.example` documents every variable.

If anything is ambiguous or you find yourself wanting to step outside Module 1,
STOP and ask before coding.

When complete:
- Update `status.md`: move Session 1 to "Completed" with today's date; note any deviations.
- Rewrite `handoff.md` so the next session can pick up cleanly.
- Flag anything that should change in `CLAUDE.md` or `modules.md`.
```

---

## After Session 1 finishes

Come back to Cowork and I'll generate the Session 2 prompt (Tracerfy skip-trace + scrub),
informed by what actually got built. Per the plan, the **parallel review team** kicks in
on the sensitive modules — Sessions 3 (send path) and 4 (STOP/suppression) — not on this
scaffold session.
