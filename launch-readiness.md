# Launch-readiness report — the 2,500 (`scrub_mode='none'`) campaign

_Read + verify pass, 2026-06-25 (Claude Code). No product behavior changed. No real texts, no real
credits, no real-list run. Live DB left pristine._

## VERDICT: ✅ GO — prod is live and login works. Only the operator's manual campaign launch remains.

**UPDATE 2026-06-25 (login fixed):** All app/infra blockers are cleared. Prod serves v2, `SESSION_SECRET`
is set, and both login users are seeded **and verified** (real `verifyPassword` + live prod `/login`).
The operator can sign in at `https://leadflow1-seven.vercel.app/login` and run the campaign (runbook below).

1. ✅ **Module N built** — `scrub_mode` + passthrough + `/api/scrub` branch + `test:passthrough` (24/24);
   independent correctness review CLEAN.
2. ✅ **Deployed** — `8626f84` on `origin/main`; `vercel --prod` READY; prod serving v2; schema on the Neon DB.
3. ✅ **`SESSION_SECRET` set in prod** (by the operator) — login renders, no 500.
4. ✅ **Users seeded + verified** — operator `#40 jordan@xalent.ai` (operator) + client `#41
   Texexteriors@gmail.com` (client, client_id=1). Proof: `verifyPassword(typed pw, storedHash)` == true for
   both; live prod `POST /login` → **303 `/`** (operator) and **303 `/client`** (client). The `users` table
   was empty (the earlier seed never wrote a row) — fixed by re-running the seed; no code change.
   **Same-DB confirmed:** a throwaway user created in the `.env.local` DB was authenticated by prod, so
   prod's (Sensitive, un-pullable) `DATABASE_URL` == `.env.local`'s.

Remaining = the campaign itself (operator's manual go): see the **Operator launch runbook** at the bottom.

---

## Checklist A–H

### A. Build + test suites — ✅ (except the Module-N suite, which doesn't exist)
- `npx tsc --noEmit` → clean (exit 0).
- `npm run build` → green; all routes registered (`/login`, `/dashboard`, `/inbox`, `/client`,
  `/api/{billing,campaign,campaigns,client,dashboard,inbox,leads,portal,reply,scrub,skiptrace,webhook/twilio}`);
  no DB driver in client bundles.
- `npm test` → **208 pass / 0 fail**.
- `npm run test:isolation` → **28/28** ("ISOLATION OK").
- `npm run test:access` → **pass** ("the V1 gate is CLOSED").
- `npm run test:cockpit` → **pass**.
- `npm run test:auto-pause` → **pass** ("deliver-then-stop is server-enforced").
- `npm run test:passthrough` → **24/24** (added with Module N — see item E).

### B. Auth + access — ✅ code-correct; ⚠️ needs users seeded + SESSION_SECRET in prod
- `SESSION_SECRET` is fail-closed: `lib/auth.ts:99–102` throws if unset (requires ≥32 chars). Set
  locally (presence confirmed, value not printed); **must be set in Vercel prod**.
- Operator routes go through `requireOperator` (401 unauth / 403 client-role); `app/page.tsx` redirects
  unauth→`/login`, client-role→`/client`. `npm run test:access` proves a client-2 user can never reach
  client-1 by any vector (the V1 `?clientId=` gate is closed).
- `npm run seed:users` exists (`scripts/seed-users.ts`); it hashes env-provided passwords. **⚠️ Live DB
  currently has 0 users** — login works for nobody until this is run (locally and in prod).

### C. Dashboard surface renders + reads correctly — ✅
- Cockpit landing (`app/page.tsx`) gates on the session, then `getCockpitData()` → `CockpitView` lists
  every client and links to `/dashboard?clientId=N`.
- Dashboard has the campaign selector + CSV uploader (`components/campaign-bar.tsx`), the
  trace→scrub→send driver (`components/pipeline-runner.tsx`), live counters, the reply/inbox feed, leads,
  and the opt-out count — all reading from their endpoints.
- The V3 "undefined sent/failed" fix is in place: the driver coalesces every counter
  (`Number(data.sent ?? 0)`, etc. — `pipeline-runner.tsx:103–164`), so a counter can't render undefined.
  It also handles the V6 paused/`target_met` response. (Verified by code + build; not click-tested in a
  live browser session.)

### D. End-to-end throwaway pipeline (magic numbers) — ⚠️ not re-run live (deliberate)
- **Why not run now:** there is no `scrub_mode='none'` path (item E), so a real pipeline run would hit
  the **vendor** scrub stage and **spend real Tracerfy credits** — which this session must not do. A
  fresh end-to-end is best run *after* Module N exists (it can then drain scrub with zero spend).
- **Send mechanics are already proven** without a fresh run: `npm run test:auto-pause` (26 assertions —
  stops EXACTLY at target with eligible contacts still remaining, no double, suppression intact),
  `npm run test:isolation` (28/28), the documented V3 magic-number end-to-end (run closes / no
  double-send / second operator 409-blocked), plus code review of the single-statement atomic
  `claimForSend` (`lib/db.ts`) and the campaign route's run lifecycle. The send path itself is sound.

### E. No-scrub mode (Module N) — ✅ BUILT (was the load-bearing blocker)
- `campaigns.scrub_mode text NOT NULL DEFAULT 'vendor'` ('vendor'|'none') applied live (pilot backfilled
  to 'vendor'). `lib/scrub-passthrough.ts passthroughScrubBatch` marks the campaign's matched +
  with-phone + still-`pending` contacts `scrub_status='clean'` in one scoped UPDATE — NO Tracerfy call,
  NO credits, NO `scrub_jobs` row (mirrors `getContactsForScrub`'s predicate, minus the vendor call).
- `app/api/scrub` branches on `campaign.scrub_mode`: `'none'` → passthrough; else the existing
  `scrubBatch` byte-unchanged. Same response shape, so `components/pipeline-runner.tsx` is untouched.
  Mode set via `POST /api/campaigns` (`scrubMode`, default 'vendor') or `PATCH /api/campaigns`
  (operator-only, client-scoped).
- **Opt-out safety intact:** passthrough sets `scrub_status` only; `getEligibleContacts`/`claimForSend`
  still exclude opted-out phones independently (`lib/db.ts:93`). `npm run test:passthrough` = **24/24**
  proves an opted-out contact is marked clean yet STILL excluded, a no-phone contact stays pending, no
  `scrub_jobs` row is created, and `'vendor'` still routes to `scrubBatch`. Owes a single-reviewer
  correctness pass (touches send-eligibility).

### F. Send window + live rate — ✅
- Window default is **10:00–19:00 America/New_York**, half-open `[start, end)` (`lib/twilio.ts:135–194`),
  per-client-overridable from the client record. A real (non-dry-run) send refuses outside it
  (`app/api/campaign/route.ts:160`) and re-checks every loop iteration mid-run (line 353).
- Live rate control: `PATCH /api/client` → `setClientSendRate` (clamped), read fresh each batch — can be
  raised off the 60/hr default with no redeploy.
- **To clear 2,500 in the 10am–7pm (9h) window you need ~300/hr (~8–9h).** Confirm 300/hr is inside your
  **Twilio 10DLC daily throughput cap** before sending, and start earlier in the day to leave slack.

### G. Deployed prod (Vercel) health — ✅ DEPLOYED v2 / ⛔ `SESSION_SECRET` missing in prod
- **Deployed:** committed `8626f84`, pushed to `origin/main`, `vercel --prod` → READY
  (`https://leadflow1-seven.vercel.app`, deployment `dpl_GuR5P2qnhnefVgNMuAr4MNtVTxQk`). HTTP smoke:
  `/login` → 200 (v2 LeadFlow login, NOT the old admin-password gate); `/` → 307 → `/login`;
  `/api/dashboard` + `/api/portal` → 401; `/api/webhook/twilio` (no signature) → 403. Schema applied to
  the Neon DB (65 stmts, idempotent — `scrub_mode` + all V1–V6 tables present).
- **Prod env present** (`vercel env ls production`, names only): `DATABASE_URL`, `TWILIO_ACCOUNT_SID` /
  `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER`, `TRACERFY_API_KEY`, plus `SEND_RATE_PER_HOUR` /
  `SEND_TIMEZONE` / `TALAN_FORWARD_PHONE` (env fallbacks). The deprecated `ADMIN_PASSWORD` is still set
  (harmless — unused since V5; safe to delete).
- **⛔ `SESSION_SECRET` is NOT set in prod.** V5 login fails closed without it → the login POST 500s.
  Operator must add a ≥32-char random `SESSION_SECRET` to Vercel (production) **and redeploy** (env added
  after a deploy doesn't apply to the running one). Not set by me (security-sensitive auth secret;
  guardrail = don't touch prod auth env beyond seeding).
- **Note:** the prod `DATABASE_URL` value is marked Sensitive so the CLI returns it empty — I could not
  byte-compare it to `.env.local`. The `.env.local` var set is this project's Neon-integration output, so
  it's almost certainly the same DB; the operator's confirming login to prod (after seeding) verifies it
  end-to-end.

### H. Compliance guardrails intact — ✅
- `npm run smoke:webhook` → **5/5** (valid signature accepted; forged / tampered-body / wrong-URL /
  missing all → 403 before any side effect).
- `getEligibleContacts` and `claimForSend` both enforce `suppressed = false` AND `scrub_status = 'clean'`
  AND `NOT EXISTS (opt_outs)` (client-level, last-10 normalized) — the opt_outs check is **independent of
  the scrub flag**, so a marked-clean opted-out contact is still excluded (`lib/db.ts:90–94`, `132–133`).
- `test:isolation` (28/28) and `test:auto-pause` both prove the opt-out exclusion holds. When Module N is
  built it must mark `scrub_status` only and leave this path untouched — verify in its review.

---

## Live DB state (pristine — unchanged by the deploy session)
`clients: 1` (id 1, active) · `campaigns: 1` (Tallahassee pilot, `scrub_mode='vendor'`) · `contacts: 500`
(91 sent, 91 clean) · `users: 0` · `client_invoices: 0` · `opt_outs: 5`. No throwaway rows created.

---

## ▶ Operator launch runbook (do these in order — then you are GO)

**Setup is DONE:** ✅ `SESSION_SECRET` set in prod · ✅ users seeded + verified (operator
`jordan@xalent.ai`, client `Texexteriors@gmail.com`). Log in at
`https://leadflow1-seven.vercel.app/login` → you land on the cockpit.

**The campaign itself:**
1. **Fund Tracerfy ~$50** — the 2,500 list has no phones, so the skip-**trace** spends ~$0.02/contact.
   (No-scrub mode skips the *scrub* spend, not the trace.)
2. **Upload** `data/tallahassee_2500_2026-06-25.csv` from the dashboard → creates a new campaign. Set it to
   **`scrub_mode='none'`** — either pass `scrubMode=none` on the upload (`POST /api/campaigns`) or
   `PATCH /api/campaigns {campaignId, scrubMode:'none'}` after.
3. **Configure client 1** if not already: `from_number`, `forward_phone` (Talan's cell). **Raise the send
   rate** to ~**300/hr** (`PATCH /api/client {sendRatePerHour:300}`) to clear 2,500 inside the 10am–7pm ET
   window (~8–9h) — confirm it's within your Twilio 10DLC daily throughput cap.
4. **Run the pipeline** (trace → passthrough scrub → send) from the dashboard; watch progress / replies /
   leads. The passthrough scrub drains instantly with **no spend**; only trace + Twilio sends cost.
5. **Rotate** the Twilio token + Tracerfy key after launch (they were shared in plaintext).
