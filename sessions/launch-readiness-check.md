# Launch-readiness check — is the dashboard ready to run the 2,500 campaign today?

> Self-contained prompt. You are **Claude Code** in the LeadFlow repo. The operator runs `/clear` before
> each prompt, so assume NO prior context. Cowork writes prompts; you execute. **This is a READ + VERIFY
> session — NOT a build.** Produce a clear GO / NO-GO. Do not change product behavior (only fix a trivial
> wiring bug if you find one, and flag anything larger). Do NOT text real numbers, spend real credits, or
> run the real 2,500 list.

---

## 0. Orientation — read these first (in order)
1. `CLAUDE.md` — stack, conventions, hard rules (≤500 lines/file, fail-closed scrub, NEVER text an
   opted-out number, idempotent/resumable send, secrets via env).
2. `overview.md` — the decision log (most recent on top). Note: V1–V6 done; the 2026-06-25 decisions for
   **Module N (no-scrub `scrub_mode='none'` passthrough)** and **Module S (TCPA litigator scrub)**.
3. `handoff.md` + `status.md` + `modules-v2.md` — current state and what's built vs. pending.
4. The operator launch surface you're verifying: `app/page.tsx` (cockpit landing), `lib/cockpit.ts`,
   `components/cockpit-view.tsx`, `app/dashboard/*`, `lib/dashboard.ts`, `components/campaign-bar.tsx`
   (CSV uploader + campaign select), `components/pipeline-runner.tsx` (trace→scrub→send driver),
   `app/api/{campaigns,skiptrace,scrub,campaign,client,dashboard}/route.ts`, the inbox/leads
   (`lib/inbox-db.ts`, the inbox page), auth (`lib/session.ts`/`lib/guard.ts`/`lib/access.ts`).

**Read those before doing anything.**

---

## 1. Goal
Verify, end-to-end, that the operator can log in, drive a campaign through **CSV upload → trace → scrub →
send → progress → replies/leads** from the dashboard, and that the deployed prod app is healthy — so the
operator can launch a real ~2,500-contact campaign today with confidence. Output a checklist GO/NO-GO with
each item ✅ / ⚠️ / ❌ and the exact remaining operator to-dos.

This campaign sends with **`scrub_mode='none'`** (no vendor DNC scrub — Module N), so the no-scrub path is
part of what must be ready. TCPA/Module S is NOT used on this campaign.

---

## 2. Verify each item (record evidence + a ✅/⚠️/❌ for each)

**A. Build + test suites green.** Run `npx tsc --noEmit`, `npm run build`, `npm test`,
`npm run test:isolation`, `npm run test:access`, `npm run test:cockpit`, `npm run test:auto-pause`, and
(if Module N is built) `npm run test:passthrough` and (if Module S is built) its scrub tests. Report the
pass counts. Any red → ❌ with the failure.

**B. Auth + access.** Confirm operator login works (post-V5 per-user login): `SESSION_SECRET` is read and
fail-closed if unset; an unauthenticated request to `/dashboard` and the operator API routes
redirects/401s; a client-role user cannot reach operator routes (lean on `test:access`). Confirm
`npm run seed:users` exists and what it needs. Note (do NOT print values) whether `SESSION_SECRET` is set
locally and remind that it must be set in **Vercel** prod.

**C. Dashboard surface renders + reads correctly.** Confirm the cockpit (`app/page.tsx`) lists clients and
links to `/dashboard?clientId=N`; the dashboard shows the campaign selector + CSV uploader, the
pipeline-runner controls, live send-progress counters, the reply/inbox feed, leads, and the opt-out count
— all reading from their endpoints with no crash and no "undefined sent/failed" (the V3 counter fix).
Spot-check the data path in code; where practical, hit the read endpoints (authed) and confirm 200 + shape.

**D. End-to-end pipeline on a THROWAWAY campaign — Twilio MAGIC test numbers only (no real texts, no real
spend).** Create a temp client/campaign, upload a tiny CSV (2–3 rows) using Twilio magic numbers, run the
driven pipeline one stage at a time, and prove: trace/scrub stages drain; the send batch closes its run
(`finished_at` set), counters are real integers, **no double-send** (atomic `claimForSend`), and the
inbox/leads/progress update. Then **delete the test rows** so the live DB is pristine (1 client, the
pilot campaign, 0 stray rows). Report before/after row counts.

**E. No-scrub mode (Module N) — the load-bearing bit for THIS launch.** If Module N is built: on a
`scrub_mode='none'` campaign, confirm the scrub stage **passthrough-marks** traced+with-phone `pending`
contacts `clean` with **NO Tracerfy/vendor call or credit spend**, AND that a contact whose phone is in
`opt_outs` is STILL excluded by `getEligibleContacts` even after being marked clean. If Module N is NOT
built yet → mark this ❌ **launch blocker** and say "run `sessions/no-scrub-mode.md` first."

**F. Send window + live rate.** Confirm the send window is **10am–7pm America/New_York** and a real
(non-dry-run) send refuses outside it. Confirm the live rate control (`PATCH /api/client` →
`send_rate_per_hour`, read fresh each batch) works and can be raised off 60/hr. State the rate needed to
clear 2,500 inside the window (~**300/hr** ⇒ ~8–9h) and remind the operator to confirm it's within their
Twilio 10DLC daily throughput before sending.

**G. Deployed prod (Vercel) health.** Confirm the deployed app is on the latest `main` commit (compare the
local HEAD to what's deployed) and healthy: the login page loads and the API routes enforce their auth
gates in prod. Enumerate which required env vars are present in prod vs. missing — `DATABASE_URL`,
`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER` (or messaging-service SID),
`TRACERFY_API_KEY`, `SESSION_SECRET`, and the client-record config (from_number, forward_phone, send
window/rate). **Never print secret values** — presence/absence only.

**H. Compliance guardrails intact (functional correctness, not legal).** Confirm STOP/opt-out suppression
still holds: `npm run smoke:webhook` (or the equivalent) green, and `getEligibleContacts`/`claimForSend`
still exclude opted-out phones. The no-scrub mode must not have weakened this.

---

## 3. Do NOT
- Do NOT change product behavior, eligibility, suppression, or the send path (fix only a trivial wiring
  bug if you hit one, and flag anything larger instead of silently changing it).
- Do NOT send to real numbers, spend real Tracerfy/Twilio credits, or run the real 2,500 list.
- Do NOT print secret values. Do NOT modify access controls or env in prod.
- Leave the live DB pristine — delete every throwaway row you create.

---

## 4. Output (the deliverable)
Write a concise **GO / NO-GO readiness report** to `launch-readiness.md` (new file) with each item A–H as
✅ / ⚠️ / ❌ + one line of evidence, then a short **"Operator to-dos before launch"** list (e.g. fund
Tracerfy ~$50 for 2,500, set `SESSION_SECRET` + `seed:users` in prod if missing, raise the send rate,
build Module N if not done). Update `status.md` (a launch-readiness entry) and rewrite `handoff.md` to
point at the launch. Keep the live DB pristine.

## 5. Verification step
Before declaring GO: re-run the full test suite list from item A and confirm all green, and confirm the
throwaway end-to-end test rows are gone (live DB back to 1 client + the pilot campaign, 0 stray rows).
A single careful pass is fine; if anything in D/E/H looks shaky, spin up a read-only reviewer to double-check
the send/suppression path before you write GO.
