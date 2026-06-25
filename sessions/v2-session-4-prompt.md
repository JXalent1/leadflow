# v2 Session 4 — Lead-guarantee cockpit (operator)

Module V4 in `modules-v2.md`. The operator's control room for the $2,500/mo + 50-leads/month model.

## Goal
An operator home screen showing EVERY client at a glance, centered on the one metric that runs the
business: **leads this cycle vs. their 50-lead guarantee** — with "who's behind pace" surfaced first,
so you know which clients need more campaigns run this month.

## Scope — do this
1. **Operator cockpit page** (the new landing after admin login): a list/grid of all clients, each row:
   - Client name + status (active/paused).
   - **Leads this cycle / guarantee** (e.g. `12 / 50`) with an on-track indicator (see pace below).
   - This cycle's sent count + reply rate + opt-out rate (a quick campaign-health read).
   - Days left in the cycle.
   - Click a client → opens their existing dashboard (scoped to that client).
2. **Lead count per client per cycle:** count `leads` per client within the current billing cycle
   (from the client's `billing_day`). Calendar month is an acceptable v1 if billing-cycle math is
   fiddly — note the choice in `overview.md`.
3. **"Behind pace" flag (the actionable bit):** expected = guarantee × (days elapsed / cycle length).
   actual < expected → **behind**; ≥ expected → **on track**; ≥ guarantee → **met ✓**. Sort/highlight
   the behind clients first.
4. **Navigation:** the cockpit is the operator landing; a client's dashboard/inbox is reached by
   clicking into them. Still behind the single shared admin password (per-client logins are V5).

## By design — NOT an isolation violation
The cockpit aggregates **summary metrics across clients** — that's correct; the operator owns all
clients. Keep it to summary counts. Per-client drill-downs and anything client-FACING (V5) stay
strictly client-scoped — no contact-level data crosses a client boundary in a per-client view.

## Do NOT
- Build client logins / access control (V5), billing collection (V6), or the visual redesign (V7 —
  this is a functional cockpit, not the pretty pass).
- Touch the send / suppression / eligibility logic. No source file over 500 lines. Don't break
  client-1 / campaign-1 (Talan).

## Acceptance
- The cockpit lists all clients with leads-this-cycle / guarantee + the behind/on-track/met flag;
  clicking a client opens their scoped dashboard.
- **Fixture:** seed a 2nd client with N leads this cycle and some last cycle; assert the cockpit
  counts only this cycle, per client, and the pace flag is right.
- Per-client views still leak nothing across clients (`npm run test:isolation` holds).
- Talan shows correctly; `npm run build` + `npm test` + `npm run test:isolation` green.
- Update `status.md`, `overview.md` (decisions, incl. the cycle definition), `modules-v2.md` (V4 →
  done), rewrite `handoff.md` for V5.

## After it passes → light review (optional)
V4 adds no send/suppression surface, so a light check is enough: the cross-client aggregate is
operator-only + correct, per-client drill-downs stay scoped, and the lead-count / pace math is right.
(Single reviewer, or lean on the isolation fixture — your call.)
