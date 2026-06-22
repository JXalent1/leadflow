# CLAUDE.md

Context for any Claude session writing code in this project. Read this first every time.

## What this project is
LeadFlow — a self-hosted SMS lead-generation tool for home-service businesses. It skip-traces a homeowner list (Tracerfy), runs a paced Twilio SMS campaign, triages inbound replies (STOP + interest), and forwards qualified leads to the client. First client: Talan, Tallahassee window cleaning. MVP goal: run a 500-record pilot and measure conversion.

## Stack
- **Next.js 14+ (App Router), TypeScript** — frontend + API routes, deployed on Vercel.
- **Postgres** via **Neon** (free tier), provisioned through the Vercel Marketplace integration, using the `@neondatabase/serverless` driver as the thin query layer. (Decided 2026-06-22 — see overview.md. NOTE: Vercel's old first-party "Vercel Postgres" and its `@vercel/postgres` driver are deprecated — do not use them. Do not introduce Supabase, the `postgres` package, or `drizzle` either.)
- **Twilio Node SDK** for SMS send + inbound webhook.
- **Tracerfy REST API** for skip trace + DNC/litigator scrub — docs: https://www.tracerfy.com/skip-tracing-api-documentation/ (Bearer token auth, credit-based).
- **Resend** (free tier) for email lead forwarding, optional.
- Tailwind CSS for the dashboard. Keep it minimal.

## Project layout
```
/app
  /api
    /skiptrace      — POST: kick off Tracerfy skip trace on uploaded contacts
    /scrub          — POST: run DNC/litigator scrub, mark suppression
    /campaign       — POST: start/throttle the send; GET: progress
    /webhook/twilio — POST: inbound SMS (STOP + interest triage + forward)
  /dashboard        — UI: list status, send progress, reply feed, leads
  /page.tsx         — entry / admin gate
/lib
  /db.ts            — DB client + query helpers
  /twilio.ts        — send helpers, pacing
  /tracerfy.ts      — skip trace + scrub client
  /classify.ts      — reply interest classification
  /forward.ts       — lead forwarding to Talan
/data
  tallahassee_test_500.csv — pilot contact list (name + situs address, NO phones yet)
/db
  schema.sql        — table definitions
```

## Conventions

### File size
No source file exceeds **500 lines of code**. Split along natural boundaries (separate concerns, extract utils, pull types into their own module).

### Naming
- TypeScript: camelCase for vars/functions, PascalCase for types/components, kebab-case for filenames.
- DB: snake_case tables and columns.

### Testing
Manual testing against Twilio/Tracerfy sandboxes until MVP ships. Add a `scripts/` smoke test for each integration (skip trace one record, send one SMS to your own phone) before running on the real list. Do not run the full 500 until smoke tests pass.

### Error handling
- Wrap all external API calls (Twilio, Tracerfy) in try/catch with logged, typed errors.
- Treat any uncertainty in scrub results as "suppress" — fail closed, never send when in doubt.
- Idempotency: sending must be resumable. Track per-contact send state so a re-run never double-texts.

### Secrets
All credentials via environment variables (`.env.local`, Vercel env). Never hardcode. Required: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (or messaging service SID), `TRACERFY_API_KEY`, `DATABASE_URL`, `TALAN_FORWARD_PHONE`, optional `RESEND_API_KEY` + `TALAN_FORWARD_EMAIL`, `ADMIN_PASSWORD`.

## Where things live
- `overview.md` — project vision, decisions, compliance note
- `status.md` — current task state (update after every task)
- `handoff.md` — session handoff snapshot (rewrite at end of each session)
- `modules.md` — the module breakdown and build order
- `sessions/session-N.md` — the deep spec for each build session

## What NOT to do
- Do not work outside the current session's scope. Each session has a defined module — stay in it.
- Do not create files over 500 lines.
- Do not skip updating `status.md` when a task completes.
- Do not invent requirements the user didn't specify. If ambiguous, ask.
- **Do not build a send path that can text a scrub-flagged or opted-out number.** Suppression and STOP handling are hard requirements.
- Do not add number rotation, multi-tenant, or AI-conversation features in MVP — they're explicitly out of scope.
- Do not run any send against the real list before the single-record smoke tests pass.

## Current session
Before starting, read `sessions/session-N.md` where N is the session indicated in the kick-start prompt.
