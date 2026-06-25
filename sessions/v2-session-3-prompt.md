# v2 Session 3 — Guided pipeline + de-finicky

Module V3 in `modules-v2.md`. Builds on campaigns (V2). This is the module that makes LeadFlow *feel*
like a product instead of a pile of buttons you babysit.

## Goal
One guided flow per campaign: pick/create a campaign, hit **Run**, and it drives
**trace → scrub → send** to completion on its own with live progress — the operator clicks once, not
fifty times. Plus live send-rate control, and fix the two bugs from Talan's pilot (the send-batch
stall + the "undefined sent/failed" counter).

## Scope — do this
1. **Auto-driving pipeline (the core de-finicky fix):**
   - A guided campaign view that advances **trace → scrub → send** with live per-stage progress,
     driven automatically — the operator hits Run ONCE, not repeatedly per batch.
   - Recommended mechanism: a **client-side driver** that re-invokes the next batch endpoint and polls
     progress until a stage completes, then moves to the next stage (this avoids serverless timeouts
     AND removes the manual re-clicking). **Resumable:** if the tab closes, reopening + Resume picks
     up from the DB state.
   - **Each auto-resumed batch MUST still go through the existing per-batch path** — `getEligibleContacts`
     + the atomic `claimForSend` (with the V2 opt-out re-check). Auto-resume may NOT bypass
     suppression/eligibility; the suppression guarantee must hold on every batch.
2. **Fix the send-batch stall:** the campaign run must mark itself **finished** (`finished_at`) when a
   batch completes with nothing left, and the active-run guard must let the driver continue its OWN
   run (not block itself) while still blocking a *second* concurrent operator. No double-send.
3. **Fix the "undefined sent / undefined failed" counter** — the batch-result banner reads the real
   result fields.
4. **Live send-rate control:** let the operator edit the send rate (the client/campaign
   `send_rate_per_hour`, now stored in the DB since V1) from the dashboard; the send loop reads it
   live so a change takes effect on the next batch — **no redeploy.**

## Do NOT
- Build the operator cockpit (V4), client logins (V5), billing (V6), or the full visual redesign
  (V7 — this is *functional* pipeline UX, not the pretty pass).
- Change the eligibility/suppression LOGIC — only the driving + UX around it.
- Break client-1 / campaign-1 (Talan) behavior. No source file over 500 lines.

## Acceptance
- Clicking **Run** once drives trace → scrub → send to completion with live progress, **no manual
  re-clicking, no stall**; the run closes (`finished_at` set) and the active-run guard clears.
- The counter shows real numbers — never "undefined".
- Changing the send rate on the dashboard takes effect on the next batch with no redeploy.
- A STOP that lands mid-run still excludes that phone from the rest of the run (the V2 atomic re-check
  holds under auto-resume).
- Talan unchanged; `npm run build` + `npm test` + `npm run test:isolation` green.
- Update `status.md`, `overview.md` (decisions), `modules-v2.md` (V3 → done), rewrite `handoff.md`
  for V4.

## After it passes → focused review
A light review of the send-driver: no double-send under the auto-resume + active-run-guard model;
suppression re-checked per batch; the run closes correctly; rate is read live. (Single careful
reviewer or a 2-lens team — your call; smaller compliance surface than V1/V2, but it does touch the
send loop.)
