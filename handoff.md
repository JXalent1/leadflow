# Handoff

_For the next session — read this first._

_Last updated: 2026-06-25 (Claude Code — Module N (no-scrub mode) BUILT. Remaining launch blockers:
deploy-to-prod + seed users. See `launch-readiness.md`.)_

## TL;DR
LeadFlow is a self-hosted SMS lead-gen tool; v1 shipped a live pilot for Talan (91 sent). v2 turns it
into an agency product. **V1–V6 + Module N are built (locally, uncommitted).** The operator wants to
launch a **~2,500-contact campaign that sends with `scrub_mode='none'`** (no vendor DNC scrub). Module N
just landed, so that path now exists. The launch-readiness report (`launch-readiness.md`) is **still
NO-GO**, but only on two OPERATIONAL blockers now (deploy + seed users), not on missing code.

## ▶ Immediate next: clear the 2 remaining launch blockers
1. **Commit + push + deploy to Vercel.** Local `HEAD` = `origin/main` = `5a19d5c` (V1). All of V2–V6 +
   Module N are uncommitted. The deployed `leadflow1` app is at V1 — no login, campaigns, cockpit,
   auto-pause, or the no-scrub path. Deploy the working tree **and apply the schema in prod**
   (`npm run schema` adds the `scrub_mode` column, idempotent).
2. **Seed users + set `SESSION_SECRET` in Vercel.** The live DB has **0 users**; V5 login replaced the
   shared admin password, so nobody can log in. Run `npm run seed:users` (locally + prod) with
   `SESSION_SECRET` (≥32) set.

Also owed (not launch-blocking): a **single-reviewer correctness pass on Module N** (it touches
send-eligibility) and the **focused send-path review of V6** (the auto-pause gate), before V7.

## What Module N shipped (2026-06-25 — all green)
- **Schema:** `campaigns.scrub_mode text NOT NULL DEFAULT 'vendor'` ('vendor'|'none'); pilot + existing
  rows backfilled to 'vendor' (Talan byte-unchanged). Applied live (`npm run schema` = 65 stmts).
- **Passthrough:** `lib/scrub-passthrough.ts passthroughScrubBatch(clientId, {campaignId, limit})` — one
  scoped UPDATE marks matched + with-phone + `pending` contacts `scrub_status='clean'`, NO Tracerfy
  call / credits / `scrub_jobs` row. Mirrors `getContactsForScrub`'s predicate minus the vendor call.
- **Route:** `app/api/scrub` branches on `campaign.scrub_mode` ('none' → passthrough, else `scrubBatch`
  byte-unchanged). Same `{scrubbed,clean,suppressed}` response, so `pipeline-runner.tsx` is untouched.
- **Setters:** `POST /api/campaigns` takes optional `scrubMode` (default 'vendor'); `PATCH
  /api/campaigns {campaignId, scrubMode}` flips an existing campaign (operator-only, client-scoped,
  validates the value). `lib/campaigns.ts` gained `ScrubMode`/`isScrubMode`/`setCampaignScrubMode`.
- **Test:** `npm run test:passthrough` (24/24). Deviation: the explicit live HTTP smoke was covered by
  this fixture (same live-DB code path; login is a server action + 0 users seeded → scripted HTTP login
  is brittle; the route is a thin auth+branch wrapper proven by tsc+build).

## Gotchas the next session must know
- **To run a no-scrub campaign:** create it with `scrubMode:'none'` (or PATCH an existing one), then the
  pipeline's Run drives trace → (passthrough) scrub → send normally — the scrub stage drains instantly
  with no spend. The TRACE stage still spends Tracerfy (~$0.02/contact) — no-scrub only skips the SCRUB.
- **Opt-out exclusion is independent of `scrub_status`** — Module N must never change that. The
  passthrough marks clean; `getEligibleContacts`/`claimForSend` still exclude opted-out phones. Keep
  `test:passthrough` + `test:isolation` green.
- **`apply-schema` splits on `;` and strips `--` comments** — NO `;` inside a comment (Module N's first
  schema comment had one and broke the apply; fixed by rewording). Each statement individually idempotent.

## What's verified green right now (2026-06-25)
`npx tsc --noEmit` clean; `npm run build` green; `npm test` = **208**; `npm run test:isolation` = **28/28**;
`npm run test:access` pass; `npm run test:cockpit` pass; `npm run test:auto-pause` pass; `npm run
smoke:webhook` = **5/5**. Send window = 10:00–19:00 America/New_York `[start,end)` (`lib/twilio.ts`),
real send refuses outside it + re-checks each loop; live rate via `PATCH /api/client`. Eligibility +
opt-out suppression intact and independent of the scrub flag (`lib/db.ts:90–94`).

## Live DB state (pristine)
1 client (id 1, active) · 1 campaign ("Tallahassee pilot", sending) · 500 contacts (91 sent, 91 clean) ·
**0 users** · 0 invoices · 5 opt_outs. The readiness pass created no throwaway rows; all fixtures
self-cleaned.

## Operator to-dos before the 2,500 launch (full list in launch-readiness.md)
- Build Module N → deploy the tree → seed users + `SESSION_SECRET` in Vercel (the 3 blockers above).
- **Fund Tracerfy ~$50** for the skip-trace of the 2,500 (list has no phones; ~$0.02/trace). No-scrub
  mode skips the *scrub* spend, not the *trace* spend.
- **Raise the send rate to ~300/hr** (off the 60/hr default) to clear 2,500 inside the 9h window; confirm
  it's within the Twilio 10DLC daily throughput cap.
- Set client 1's `from_number` / `forward_phone` (Talan's cell) / send window in the client record;
  create the 2,500 campaign with `scrub_mode='none'` (once Module N exists).
- Rotate the Twilio token + Tracerfy key (shared in plaintext).

## Compliance reminder (unchanged hard requirements)
Never text a scrub-flagged / no-match / opted-out / unscrubbed number; honor STOP instantly +
permanently. Module N must mark `scrub_status='clean'` ONLY and leave `getEligibleContacts` /
`claimForSend` / the inbound webhook / opt-out logic byte-unchanged — the opt_outs exclusion is
independent of the scrub flag, so an opted-out contact stays excluded even when passthrough marks it
clean. Prove that in Module N's fixture + its single-reviewer correctness pass.

## Gotchas carried forward
- `apply-schema` splits on `;` and strips `--` comments — no `;` inside a comment; each statement
  individually idempotent; no DO/PL-pgSQL blocks.
- `SESSION_SECRET` REQUIRED (≥32), fail-closed (`lib/auth.ts:99`). Login throttle is in-memory
  (per-instance) — durable limiter still deferred. `lib/tracerfy.ts` is 536 lines (>500, pre-existing).
- The V6 auto-pause gate returns HTTP 200 `done:true` (not 4xx) so the pipeline driver stops cleanly —
  don't "fix" it to a 4xx.
