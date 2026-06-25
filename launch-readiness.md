# Launch-readiness report — the 2,500 (`scrub_mode='none'`) campaign

_Read + verify pass, 2026-06-25 (Claude Code). No product behavior changed. No real texts, no real
credits, no real-list run. Live DB left pristine._

## VERDICT: ❌ NO-GO (today) — but the load-bearing blocker is now cleared

**UPDATE 2026-06-25 (later same day):** Module N (no-scrub mode) is now **BUILT** (see item E below) —
the original #1 blocker is resolved. Two operational blockers remain before GO:

1. ✅ ~~Module N (no-scrub mode) is NOT built.~~ **BUILT** — `campaigns.scrub_mode` + the passthrough +
   the `/api/scrub` branch + `test:passthrough` (24/24). A `scrub_mode='none'` campaign now sends with no
   vendor scrub/spend, opt-out exclusion intact. Owes a single-reviewer correctness pass.
2. **Prod is at V1.** Local `HEAD` = `origin/main` = `5a19d5c` (V1 only). All of V2–V6 **and** Module N
   live in the uncommitted working tree. The deployed `leadflow1` app has none of campaigns / login /
   cockpit / auto-pause / the no-scrub path. → **Commit + push + deploy the working tree.**
3. **No users seeded.** The live DB has `users: 0`. Login (V5) replaced the shared admin password, so
   with zero users **nobody can log in** to drive the campaign. → **Run `npm run seed:users`** (locally
   and in prod) with `SESSION_SECRET` set.

Everything else (build, tests, auth gating, eligibility/suppression, send window, webhook signature gate)
is green. Once the tree is deployed and users are seeded, this should flip to GO.

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

### G. Deployed prod (Vercel) health — ❌ BLOCKER (prod is behind) / ⚠️ env unverified
- `git status -sb` → `main...origin/main`, both at **`5a19d5c` (V1)**. 79 files are uncommitted/untracked
  (all of V2–V6 + the launch files). **The deployed `leadflow1` app is at most V1** — no login, no
  campaigns, no cockpit, no auto-pause, no no-scrub path. A deploy of the current tree (after Module N)
  is mandatory.
- **Env in prod — verify in the Vercel dashboard (I cannot read prod env from here):** `DATABASE_URL`,
  `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` (or messaging-service SID),
  `TRACERFY_API_KEY`, `SESSION_SECRET` (≥32), plus the **client-record** config (from_number,
  forward_phone, send window/rate). All are present in `.env.local`; presence in Vercel is **unverified**.

### H. Compliance guardrails intact — ✅
- `npm run smoke:webhook` → **5/5** (valid signature accepted; forged / tampered-body / wrong-URL /
  missing all → 403 before any side effect).
- `getEligibleContacts` and `claimForSend` both enforce `suppressed = false` AND `scrub_status = 'clean'`
  AND `NOT EXISTS (opt_outs)` (client-level, last-10 normalized) — the opt_outs check is **independent of
  the scrub flag**, so a marked-clean opted-out contact is still excluded (`lib/db.ts:90–94`, `132–133`).
- `test:isolation` (28/28) and `test:auto-pause` both prove the opt-out exclusion holds. When Module N is
  built it must mark `scrub_status` only and leave this path untouched — verify in its review.

---

## Operator to-dos before launch (in order)
1. ✅ ~~Build Module N.~~ **DONE** (item E). Optionally run the single-reviewer correctness pass it owes.
2. **Commit + push + deploy** the working tree to Vercel — prod is at V1; nothing past it ships until you
   do (item G). Apply the schema migration in prod too (`scrub_mode` column).
3. **Seed users** — `npm run seed:users` (with `SESSION_SECRET` set), locally **and** in prod. The DB has
   0 users; nobody can log in otherwise (item B).
4. **Set `SESSION_SECRET` (≥32) in Vercel** and verify every required env var is present in prod (item G).
5. **Fund Tracerfy ~$50** for the **skip-trace** of the 2,500 (the list has no phones; ~$0.02/trace).
   No-scrub mode skips the *scrub* spend, **not** the trace spend.
6. **Raise the send rate to ~300/hr** before sending (off the 60/hr default) and confirm it's inside your
   Twilio 10DLC daily cap (item F).
7. **Configure client 1's record** — `from_number`, `forward_phone` (Talan's cell), send window — and
   create the 2,500 campaign with `scrub_mode='none'` once Module N exists.
8. **Rotate** the Twilio token + Tracerfy key (shared in plaintext per handoff) before/after launch.

## Live DB state (pristine — unchanged by this session)
`clients: 1` (id 1, active) · `campaigns: 1` (Tallahassee pilot, sending) · `contacts: 500` (91 sent,
91 clean) · `users: 0` · `client_invoices: 0` · `opt_outs: 5`. No throwaway rows created (item D's live
pipeline was intentionally not run). All fixtures self-cleaned (each reported "client 1 … unchanged").
