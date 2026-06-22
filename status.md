# Status

_Last updated: 2026-06-22_

## Current phase
Planning → Building (dev-prep complete, Session 1 prompt finalized, ready to run)

## Completed
- 2026-06-22 Sourced Leon County certified tax roll (111k parcels), filtered to owner-occupied single-family in 5 target zips, sampled clean 500-record test list (`data/tallahassee_test_500.csv`).
- 2026-06-22 project-prep: created overview.md, status.md, handoff.md, RULES.md.
- 2026-06-22 dev-prep: created CLAUDE.md, modules.md, sessions/session-1.md.
- 2026-06-22 Decided DB = Neon Postgres (via Vercel Marketplace integration; driver `@neondatabase/serverless` — old `@vercel/postgres` is deprecated) and build approach (sequential per-module + parallel review team on sensitive modules); locked DB choice across CLAUDE.md, overview.md, session-1.md; wrote finalized Session 1 kick-start prompt (`sessions/session-1-prompt.md`).

## In progress
- (nothing yet — Session 1 not started)

## Next up
- Session 1: Project scaffold + data model + DB setup.
- Session 2: Tracerfy skip-trace + scrub integration.
- Session 3: Twilio send engine (paced) + suppression enforcement.
- Session 4: Inbound webhook (STOP + interest triage) + lead forwarding.
- Session 5: Dashboard UI.
- Session 6: Deploy to Vercel + run pilot.

## Blocked / waiting on
- **Session 1 input:** Neon database created (Vercel → Storage → Neon) + `DATABASE_URL` / `POSTGRES_*` vars in `.env.local`. Provider is chosen (Neon via Vercel integration); the database itself still needs to be created. This is the only thing gating Session 1.
- Tracerfy API key — needed by Session 2.
- Twilio credentials (account SID, auth token, messaging service / number) — needed by Session 3.
- Final approved SMS copy (variants drafted in `sms-copy.md`, need sign-off) — needed by Session 3.
- Talan's forwarding contact (cell + email) + delivery method (SMS / email / both) — needed by Session 4.
