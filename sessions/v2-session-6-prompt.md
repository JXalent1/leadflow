# v2 Session 6 — Lead-target auto-pause + billing tracking

Module V6 in `modules-v2.md`. Reframed from "billing" per the operator's model: the headline is
**deliver-then-stop**; billing is track-only (no Stripe). Single focused session, then a focused
review (it touches the send path).

## Goal
1. **Deliver-then-stop (the operational core):** each client has a lead TARGET per period (e.g.
   15/week or 50/month). The moment a client hits their target for the current period, the tool
   **STOPS sending** for them — no wasted texts/credits past the goal — and resumes automatically when
   the next period begins.
2. **Billing tracking (track-only, manual collection — NO Stripe):** track each client's subscription
   ($2,500/mo, billing day, active/paused) + invoiced/paid status per cycle, surfaced on the cockpit.
   You collect outside the app.

## Scope — do this
1. **Per-client lead target + period:**
   - Add `lead_target` (int, default = `lead_guarantee`) and `target_period` ('week'|'month', default
     'month') to `clients`. (`lead_guarantee` stays the contractual number for the cockpit; `lead_target`
     drives the auto-pause — usually equal, but a client could be set to "15/week".)
   - Compute leads in the CURRENT target period: month = the billing cycle (reuse `lib/billing-cycle.ts`
     from V4); week = ISO week Mon–Sun (or rolling 7-day — note the choice in `overview.md`).
2. **Auto-pause on target hit — SERVER-ENFORCED (the load-bearing part):**
   - Before sending for a client, check `leads-in-current-target-period` vs `lead_target`. If met
     (`>=`), the send path does NOT send for that client: the campaign route refuses with a clear
     reason and the pipeline driver stops with a "**Target met (15/15 this week) — paused until
     <next period>**" state.
   - Enforce this in the **send route**, not just the UI, so hitting Run can never over-send. It is a
     business gate layered ON TOP of the existing suppression/eligibility — it must NEVER weaken or
     bypass suppression (a target NOT met doesn't make anyone suppressed eligible).
   - When the period rolls over (new week/month), the count resets below target → sending resumes.
3. **Billing tracking (light, no Stripe):**
   - Record each client's billing cycles + status — a `client_invoices` table (`client_id`,
     `period_start`, `period_end`, `amount_cents`, `status` 'due'|'invoiced'|'paid', timestamps) with
     operator actions to mark invoiced/paid. Surface next-bill-date + due/paid on the cockpit.
4. **Surfacing:** the cockpit (and the client's dashboard/pipeline) shows leads-this-period / target,
   an **auto-pause badge** when the target is met, and billing status (paid / due / next bill date).

## Do NOT
- Build Stripe / any real payment processing (manual collection only). Build the full visual redesign
  (V7). No source file over 500 lines.
- Weaken or bypass the suppression/eligibility gates — auto-pause is an ADDITIONAL stop, never a relax.
- Break client-1 (Talan).

## Acceptance
- **Auto-pause fixture (server-side):** a client with `lead_target` = 2 (test value) auto-stops after
  2 leads in the period — the campaign send route refuses further sends AND the pipeline shows "target
  met"; raising the target or rolling the period resumes sending. Prove the gate is server-enforced,
  not just UI, and the period boundary is correct (off-by-one safe).
- Suppression/eligibility still hold — `npm run test:isolation` + `npm run test:access` green; the
  auto-pause is purely additive (never makes a suppressed/opted-out contact sendable).
- Billing: a client's invoice/paid records show on the cockpit; next-bill-date correct.
- Talan unchanged; `npm run build` + `npm test` + all test suites green.
- Update `status.md`, `overview.md` (decisions incl. the week-period definition), `modules-v2.md`
  (V6 → done), rewrite `handoff.md` for V7.

## After it passes → focused review
The auto-pause touches the send path: review that it stops EXACTLY at the target (no over-send, no
off-by-one), resumes correctly on period rollover, is enforced server-side (not just UI), and does
NOT weaken suppression/eligibility. (Correctness + a compliance spot-check; single careful reviewer
or a 2-lens team.)
