# Handoff

_For the next Cowork session — read this first._

_Last updated: 2026-06-22_

## TL;DR
LeadFlow is a self-hosted SMS lead-gen tool for home-service businesses. First client is Talan (Tallahassee window cleaning). The 500-record test list is built and sitting in `data/tallahassee_test_500.csv`. Project docs and the full build plan are done. Next step is running Session 1 in a coding agent to scaffold the app.

## Where we left off
Completed project-prep and dev-prep. The module map (`modules.md`) is approved and Session 1's spec (`sessions/session-1.md`) is written. No code exists yet.

## Immediate next action
Create the Neon database (Vercel → Storage → Neon, the marketplace Postgres provider) and put its connection vars + `ADMIN_PASSWORD` in `.env.local`, then run the finalized Session 1 kick-start prompt (`sessions/session-1-prompt.md`) in Claude Code to scaffold the project and stand up the data model. (Tracerfy key, Twilio creds, and Talan's contact are NOT needed until Sessions 2–4.)

## Key files
- `overview.md` — project context, stack, decisions, compliance note.
- `status.md` — task state and what's blocked.
- `modules.md` — the 6-module build plan and order.
- `CLAUDE.md` — what the coding agent reads every session.
- `sessions/session-1.md` — first build session spec.
- `data/tallahassee_test_500.csv` — the pilot contact list (name + situs address, no phones yet).

## Open questions / pending input
- ~~DB provider~~ — resolved: **Neon Postgres** via the Vercel Marketplace integration, driver `@neondatabase/serverless` (the old `@vercel/postgres` is deprecated). Still need the database created + `DATABASE_URL`/`POSTGRES_*` in `.env.local` before Session 1.
- Lead forwarding to Talan: SMS, email, or both? (Session 4.)
- SMS copy: which variant(s) to run — see `sms-copy.md` (Session 3).

## Context the next session needs
- The list has NO phone numbers yet — Session 2 (Tracerfy) appends them. Don't try to send before skip trace + scrub.
- Compliance is built-in, not optional: suppression of scrub-flagged numbers and instant STOP handling are hard requirements, specced in modules 2–4.
- Single aged Twilio 10DLC number, already verified — no number rotation in MVP.
- Keep every source file under 500 lines (enforced in CLAUDE.md).
