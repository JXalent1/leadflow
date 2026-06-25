# Handoff

_For the next session — read this first._

_Last updated: 2026-06-25 (Claude Code — send-rate cap raised 1000→20000/hr (+ batch cap 50→250),
deployed. V7 phase 1 launch-UI + no-scrub toggle already shipped. Prod login FIXED; ✅ GO.)_

## ▶ Send-rate cap raise (2026-06-25) — DONE + DEPLOYED
The 1,000/hr cap was an early-build artifact; the operator is an A2P-compliant 10DLC sender who wants
to send faster. Surgical change, **no safety touched**:
- `lib/pipeline.ts`: new `MAX_SEND_RATE_PER_HOUR = 20000` + shared pure `clampSendRate(rate)`
  ([1, 20000], integer, non-finite→1). `sendBatchSize` cap raised 50 → **250** (still `≈ rate/20`),
  so high rates materialize while every batch stays well under the 300s limit (worst case ~179s where
  the cap first binds at 5000/hr; 10000/hr ≈ 90s, 20000/hr ≈ 45s) and realized rate ≈ target.
- `lib/clients.ts` `setClientSendRate` now uses `clampSendRate` (ceiling 1000 → 20000).
- `components/pipeline-runner.tsx` rate input `max={MAX_SEND_RATE_PER_HOUR}`.
- **Unchanged (load-bearing):** `claimForSend` no-double-send, per-batch send-window re-check,
  opt-out/suppression/eligibility, send-confirm modal. `/api/client` PATCH validation (rejects
  non-number / <1) is unchanged and still fronts the clamp.
- **Green:** tsc/build, `npm test` = **211** (pacing tests updated), isolation 28/28, access/cockpit/
  auto-pause/passthrough all pass. **Deployed** `vercel --prod` → `https://leadflow1-seven.vercel.app`.
- Operator: set Rate/hr ≤ 20000 → Save rate → Run pipeline (realized speed still bounded by Twilio).

## ▶ V7 phase 1 (2026-06-25) — launch UI redesign + no-scrub toggle: DONE + DEPLOYED
The operator found the old UI unusable; this makes the 2,500 launch **fully point-and-click**.
- **Shared UI kit** in `components/ui/` (Tailwind-only, no new deps; Inter font, **indigo-600** accent):
  `Button` (primary/secondary/ghost/danger + loading), `Card`/`CardHeader`, `StatTile`, `Badge`
  (tone-based), `Field`/`Input`/`Select`, `SegmentedToggle`, `ProgressBar`, `AppHeader`, `wordmark`,
  `icons`. Reuse these for phase 2 (client portal + inbox) so the look stays consistent.
- **Redesigned screens:** `app/login` (+ new `components/login-form.tsx`), the operator cockpit
  (`app/page.tsx` + `cockpit-view.tsx` + `cockpit-billing.tsx`), and the operator dashboard
  (`app/dashboard` + `dashboard-client.tsx` + `count-cards.tsx` + `send-progress.tsx` +
  `pipeline-runner.tsx` + `campaign-controls.tsx` now collapsed into a secondary area). Feed
  components (`leads-table`/`reply-feed`/`opt-out-list`) re-tokened to slate for cohesion.
- **No-scrub toggle (only behavior change):** `components/campaign-bar.tsx` upload form now has a
  segmented **"DNC scrub: Standard / No scrub — send whole list"** wired to the EXISTING `scrubMode`
  field on `POST /api/campaigns` (default `vendor`). The campaign selector shows each campaign's mode
  as a badge. Did NOT change the API, `lib/campaigns.ts`, or any send/eligibility/suppression logic.
- **Green + proven:** tsc clean, build green, `npm test` = 208, isolation 28/28, access/cockpit/
  auto-pause/passthrough all pass; a throwaway create asserted `scrub_mode='none'` then deleted (live
  DB pristine). **Deployed** `vercel --prod` → `https://leadflow1-seven.vercel.app`.
- **Click-only launch:** log in → dashboard → Upload new list → pick the 2,500 CSV, set **DNC scrub =
  No scrub** → Create campaign + import → set Rate/hr (~300) + Save rate → Run pipeline (type CONFIRM).
- **The look is subjective** — expect the operator to request spacing/color/wording tweaks. The kit is
  clean so iterating is fast. **Phase 2 = redesign `/client` + `/inbox` with the same kit.**

## TL;DR
LeadFlow is a self-hosted SMS lead-gen tool; v1 shipped a live pilot for Talan (91 sent). v2 turns it
into an agency product. **V1–V6 + Module N are built, committed (`8626f84`), pushed, and DEPLOYED to
prod** (`https://leadflow1-seven.vercel.app`, smoke-verified serving v2). The operator wants to launch a
**~2,500-contact campaign that sends with `scrub_mode='none'`** (no vendor DNC scrub — Module N, built +
review-clean). The launch is **NO-GO only on two operator setup steps** (login can't happen until both):

## ▶ Status: prod login FIXED — ✅ GO. Remaining = the operator's manual campaign launch.
Prod is deployed (v2), `SESSION_SECRET` is set, and both login users are seeded + verified:
- operator `#40 jordan@xalent.ai` (operator) · client `#41 Texexteriors@gmail.com` (client, client_id=1)
- Proven: `verifyPassword(typed pw, storedHash)` == true for both, and live prod `POST /login` → 303 `/`
  (operator) and 303 `/client` (client). The operator can sign in at
  `https://leadflow1-seven.vercel.app/login`.

The only thing left is the campaign itself (operator drives): fund Tracerfy ~$50, upload the 2,500 CSV as
a `scrub_mode='none'` campaign, raise the rate to ~300/hr, Run — see the **Operator launch runbook** in
`launch-readiness.md`.

Also owed (not launch-blocking): the **focused send-path review of V6** (the auto-pause gate) before V7.

## Login diagnosis (2026-06-25) — for the record
- Symptom: prod `/login` → "Incorrect email or password" for `jordan@xalent.ai`.
- `users` table = **0 rows** in the `.env.local` DB. The operator's `seed:users` never wrote a user
  (likely a shell-mangled `!` password aborting the command).
- **Same-DB proof:** a throwaway operator created in the `.env.local` DB was authenticated by **prod**
  login (303 → `/`), then deleted. So prod's `DATABASE_URL` == `.env.local`'s, even though Vercel marks
  it Sensitive and `vercel env pull` returns it empty (can't byte-compare; the probe is definitive).
- **No code change needed:** `upsertUser` upserts the password hash on conflict; email is trimmed +
  looked up `lower(email)`. The seed script is correct — it just needs to be RUN with creds.

## What the deploy session did (2026-06-25)
- **Module N correctness gate:** CLEAN (independent read-only reviewer; all 3 invariants hold).
- **Green check:** tsc clean, build green, `npm test` = 208, isolation 28/28, access, cockpit,
  auto-pause, `test:passthrough` 24/24 — all pass.
- **Committed** `8626f84` ("feat: v2 multi-tenant (V1–V6) + no-scrub mode (N)"), 85 files, NO secrets
  staged (`.env.local` git-ignored; `.env.example` is placeholders only). **Pushed** to `origin/main`.
- **Deployed** `vercel --prod` → READY; prod smoke green (v2 login, auth gates, webhook 403).
- **Schema** applied to the Neon DB (65 stmts, idempotent). Live DB pristine (1 client, 0 users).
- **Found:** `SESSION_SECRET` missing in prod (login blocker #1) + 0 users seeded (blocker #2). Did NOT
  set them (security-sensitive secrets / guardrail).

## Prod facts for next session
- Prod URL: `https://leadflow1-seven.vercel.app` · project `leadflow1` (Vercel team `jordan-zalent-projects`,
  CLI authed as `jordan-5690`) · git remote `github.com/JXalent1/leadflow` · prod commit `8626f84`.
- Prod env present: `DATABASE_URL`, `TWILIO_*`, `TRACERFY_API_KEY`, `SEND_*`, `TALAN_FORWARD_PHONE`,
  (deprecated) `ADMIN_PASSWORD`. **Missing: `SESSION_SECRET`.** Prod `DATABASE_URL` is Sensitive (CLI
  returns it empty) so it couldn't be byte-compared to local — login-after-seed confirms the DB match.

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
