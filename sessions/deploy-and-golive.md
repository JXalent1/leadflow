# Deploy + seed users → GO for the 2,500 launch

> Self-contained prompt. You are **Claude Code** in the LeadFlow repo. The operator runs `/clear` before
> each prompt, so assume NO prior context. Cowork writes prompts; you execute. This takes the working
> tree (V2–V6 + Module N) from local → a deployed, login-ready **prod**, and clears the last two launch
> blockers (prod is at V1; 0 users seeded). Then declare GO.

---

## 0. Orientation — read these first
1. `CLAUDE.md` — stack, conventions, secrets-via-env, hard rules.
2. `launch-readiness.md` — the current GO/NO-GO. The two remaining blockers are: **(2) prod is at V1**
   (all of V2–V6 + Module N is uncommitted) and **(3) 0 users seeded** (V5 login replaced the shared
   admin password). Everything else is green.
3. `handoff.md` + `status.md` + `overview.md` (top decisions) — current state. Note Module N
   (`scrub_mode='none'` passthrough) is built + green and **owes a single-reviewer correctness pass**
   (it touched send-eligibility).
4. The files involved: `lib/scrub-passthrough.ts`, `app/api/scrub/route.ts`, `lib/db.ts`
   (`getEligibleContacts`/`claimForSend`), `app/api/campaigns/route.ts`, `lib/campaigns.ts`, the
   `seed:users` script (find it via `package.json`), and your Vercel/git setup.

**Read those before doing anything. This deploys to PROD — be deliberate.**

---

## 1. Goal
1. Quick correctness gate on Module N (owed review).
2. Verify the tree is green.
3. Commit + push + **deploy to Vercel prod** (prod currently serves V1 — it must serve V2–V6 + N).
4. Seed the operator (and Talan) login users so prod can be logged into.
5. Post-deploy smoke (no real sends, no spend).
6. Update `launch-readiness.md` → **GO**, and write the exact final manual launch steps.

---

## 2. Step 1 — Module N correctness gate (read-only, fast)
A single careful read-only pass (you may use a read-only reviewer/Explore agent). Confirm:
- `passthroughScrubBatch` sets **`scrub_status` only** (no opt-out/suppression writes, no vendor call,
  no `scrub_jobs` row), scoped to the campaign's matched + with-phone + still-`pending` contacts.
- `getEligibleContacts` / `claimForSend` are **unchanged** and the `NOT EXISTS opt_outs` check is
  independent — an **opted-out contact stays excluded even after being marked clean**.
- The route branches correctly: `scrub_mode='none'` → passthrough; else `scrubBatch` byte-for-byte.
If anything Critical/High surfaces → fix + re-run the suites before deploying. If clean (expected — the
24-assertion `test:passthrough` already asserts these), proceed. Record the verdict in `status.md`.

## 3. Step 2 — pre-deploy green check
Run and confirm all green: `npx tsc --noEmit`, `npm run build`, `npm test` (=208), `npm run test:isolation`
(28/28), `npm run test:access`, `npm run test:cockpit`, `npm run test:auto-pause`, `npm run test:passthrough`
(24/24). Then `git status` — confirm the expected uncommitted files and that **no secret files**
(`.env*`) are staged (they must stay git-ignored). Abort the deploy if any suite is red.

## 4. Step 3 — commit, push, deploy
- Commit the working tree with a clear message (e.g. `feat: v2 multi-tenant (V1–V6) + no-scrub mode (N)`).
- Push to `origin main`.
- Deploy to prod: **`vercel --prod`** (prefer the CLI — the GitHub→Vercel auto-deploy link has been
  flaky before). Confirm the deploy succeeds and the deployed commit == current `HEAD`.
- **Schema safety:** run `npm run schema` (idempotent) against the prod `DATABASE_URL` to be certain
  `campaigns.scrub_mode` and all V1–V6 tables/columns exist in prod. It must not error and must not change
  existing data. (The live DB has been on v2 throughout, so expect "already applied".)

## 5. Step 4 — seed users (so prod can be logged into)
- Find what `npm run seed:users` requires (operator + client username/password + `SESSION_SECRET`),
  read from env. **Check those env vars are present first.** If any required seed var is **missing**,
  STOP and tell the operator EXACTLY which to set — do **NOT** invent or hardcode passwords, and do not
  print any secret values.
- With the env present, run `npm run seed:users`. Confirm an **operator** user row now exists (report the
  count + roles, never the password/hash). Talan's client user is optional for launch (operator drives).

## 6. Step 5 — post-deploy smoke (NO real sends, NO spend)
- Hit the prod URL: the **login page loads**, an unauthenticated request to an operator route
  redirects/401s, and a valid operator login authenticates (or, if scripted login is brittle, confirm the
  session/guard path via the seeded user + a direct authed request). Confirm the deployed app is **v2**
  (cockpit/login present), not the old v1.
- Confirm the inbound webhook route still responds (path unchanged; routes by To→client). Do not send.
- Leave the live DB pristine — create no campaign/contact rows here (the real upload is the operator's
  final manual step).

## 7. Do NOT
- Do NOT print or commit secrets; do NOT invent user passwords.
- Do NOT send to real numbers, spend Tracerfy/Twilio credits, or upload/run the 2,500 list — that's the
  operator's final manual go (Step 8 below is instructions, not for you to execute).
- Do NOT modify access controls or env in prod beyond what seeding requires.

## 8. Output — declare GO + the operator's final launch steps
Update `launch-readiness.md` (flip blockers 2 + 3 to ✅; set verdict **GO** if the smoke passed), `status.md`,
and `handoff.md`. Then write the exact **operator launch runbook** for after this session:
1. Log in to prod as the operator.
2. Upload `data/tallahassee_2500_2026-06-25.csv` → creates a new campaign.
3. Set that campaign to **`scrub_mode='none'`** (via the `POST /api/campaigns` `scrubMode` param at
   upload, or `PATCH /api/campaigns {campaignId, scrubMode:'none'}`).
4. Set the send rate (`PATCH /api/client send_rate_per_hour=<your number>`) — confirm it's within the
   Twilio 10DLC throughput.
5. Run the pipeline (trace → passthrough scrub → send) from the dashboard and watch progress / replies /
   leads. Trace spends ~$50 on Tracerfy; the no-scrub passthrough spends nothing.

Report a one-line **GO / NO-GO** at the end.
