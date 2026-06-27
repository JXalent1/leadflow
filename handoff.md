# Handoff

_For the next session — read this first._

_Last updated: 2026-06-27 (Claude Code — multi-recipient lead forwarding: forward_phone can hold several
comma-separated numbers so a lead pings more than one person. Single-number behavior byte-unchanged.)_

## ▶ Multi-recipient lead forwarding (2026-06-27) — DONE
A client's `forward_phone` may now hold SEVERAL numbers so each lead pings more than one person (e.g.
the operator + the client owner). **Additive — suppression / eligibility / classification / the send
path / the inbound signature gate are all UNTOUCHED.**
- **New pure module** `lib/forward-phones.ts` — `parseForwardPhones(raw)`: split on comma / semicolon /
  whitespace / newline, trim, drop blanks, **dedupe by last-10 digits** (first form kept). `isProbablyPhone`
  for non-blocking UI validation. Dependency-free so the `"use client"` form can import it too.
  **GOTCHA:** whitespace IS a separator, so numbers must NOT contain internal spaces (a number like
  "+1 850 …" would be split). The form helper text says "comma-separate"; E.164 has no spaces.
- **`lib/forward.ts`** — `forwardLead` parses the recipients, pings EACH via `sendOne` (sequential,
  **never throws** — unchanged failure policy), marks the lead `forwarded` if **≥1** ping succeeds, and
  `console.error`s each per-recipient failure with its code (logs last-4 only). Total failure → false,
  lead stays on the dashboard. `buildLeadPing` text UNCHANGED. **A single number is byte-identical** to
  before. Talan/client-1 `TALAN_FORWARD_PHONE` fallback kept (scoped to client 1, may itself be a list).
  `forwardLead` gained an OPTIONAL injected `deps` (`{ send, markForwarded }`, default the real
  `sendOne`/`markLeadForwarded`) purely so the fixture can MOCK Twilio — the webhook still calls
  `forwardLead(args, cfg)` (2 args), unchanged. Note: `DEFAULT_CLIENT_ID` now imported from
  `@/lib/constants` (pure) so forward.ts stays importable without dragging lib/clients.
- **UI** `components/client-form.tsx` — the forward field is a textarea ("comma-separate multiple
  numbers", shows the recipient count) with non-blocking validation flagging clearly-invalid entries.
  No backend change: `updateClientConfig` / `POST/PATCH /api/clients` already write `forward_phone` as
  free text, and the column already holds it (NO schema change).
- **Green:** tsc/build, `npm test` = **250** (+11 parse/validation), new **`npm run test:forward`** =
  16/16 live-DB with a MOCKED `sendOne` (two recipients → two pings + `forwarded=true`; one-fail-one-
  success → still true; all-fail → false + lead stays; single → one ping), isolation/access/cockpit/
  auto-pause/passthrough/optout all pass, DB pristine.

### Operator note
Set a client's **forward phone(s)** to several **comma-separated** numbers (in the New/Edit client form)
to ping more than one person per lead — e.g. the operator + the client owner. One number behaves exactly
as before. Numbers must not contain internal spaces (use `+14075551234`, not `+1 407 555 1234`).

## ▶ 2nd-client onboarding + per-client opt-out keyword (2026-06-27) — DONE

## ▶ 2nd-client onboarding + per-client opt-out keyword (2026-06-27) — DONE
Onboard + configure a client (e.g. Jeremy, Orlando powerwashing) end to end from the operator cockpit,
with his own number, his own copy, and a `Reply "2" to opt out` instruction the system **honors**.
- **Schema:** nullable `clients.optout_keyword` (+ `optout_instruction`). NULL = STOP-only (Talan
  unchanged). Applied live (67 stmts). **Gotcha hit + fixed:** my first schema comment had a `;` in it
  ("visible copy; the classifier") — apply-schema splits on `;` even inside comments → reworded.
- **Compliance core (do NOT weaken):** `lib/classify.ts isConfiguredOptOut(body, keyword)` is pure +
  EXACT whole-normalized-body match only (trim/lowercase/strip surrounding quotes+punct). `isOptOut`
  (STOP family) is UNCHANGED, always-on, authoritative — the keyword is ADDITIVE. `lib/inbound.ts`:
  `optedOut = isOptOut(body) || (opts.optOutKeyword && isConfiguredOptOut(body, opts.optOutKeyword))`,
  checked BEFORE classification, STOP's unconditional precedence. The webhook passes
  `optOutKeyword: client.optout_keyword`.
- **Render:** `lib/sms.ts renderMessage(template, contact, bizName, optOutInstruction?)` — the safety
  guard now checks for/append's THAT client's line (`optOutInstructionFor(keyword, instruction)`), so a
  "2" client never gets a contradictory second STOP line. **Talan byte-identical** (default param keeps
  the period-form append; Talan's template includes the line so append never fires). The send path
  (`app/api/campaign/route.ts`) threads `clientOptOutInstruction(client)`.
- **lib/clients.ts:** `createClient(input)` (sane defaults + `setval` before insert so an auto-INSERT
  can't collide with a manually-seeded id) + `updateClientConfig(clientId, fields)` (per-field scoped
  UPDATEs, only provided fields). `clientOptOutInstruction(client)` derived helper.
- **API:** `POST /api/clients` (operator-only create + optional client-login user via `upsertUser`) +
  `PATCH /api/clients` (full-config edit, resolved through `resolveClientIdForUser`). The existing
  `PATCH /api/client` (live rate / lead target) is untouched.
- **UI:** `components/client-form.tsx` — `ClientFormLauncher` (`+ New client` in the cockpit summary
  strip; per-card `Edit` with `stopPropagation` since the card is a link) opens a modal with a LIVE
  preview (real `renderMessage`+`segmentInfo`+per-client opt-out line) + opt-out-keyword field + (on
  create) login email/password. `app/page.tsx` now also `listClients()` and passes them to
  `CockpitView` for prefill.
- **Green:** tsc/build, `npm test` = **239** (+31), isolation 28/28, access/cockpit/auto-pause/
  passthrough, new **`npm run test:optout`** = 16/16 live-DB (self-cleaned → DB pristine).

### Operator notes for Jeremy (client #2)
- Jeremy runs under the **existing TCR brand** (this is a test): buy a **new Twilio number**, attach it
  to the **existing 10DLC messaging service / campaign** (do NOT register a new brand for a test), then
  set it as Jeremy's `from_number` in the New-client form so his inbound STOP/"2"/replies route to him
  (`getClientByInboundNumber` matches on `from_number`, last-10).
- In the form: `optout_keyword` = `2`; `send_timezone` = `America/New_York` (**Florida is Eastern**);
  window 10–19; a powerwashing `message_template` (the form pre-fills one) — the preview must end in
  `Reply "2" to opt out` and stay single-segment. Set `scrub_mode='none'` **on his campaign at upload**
  (the no-scrub toggle), NOT on the client.
- Fund Tracerfy for his skip-trace (~$0.02/contact); no-scrub skips only the SCRUB spend.
- Operational reality: carriers honor STOP regardless of the visible "2" copy, and 10DLC traffic that
  omits standard STOP language can see more carrier filtering — STOP stays fully working in the
  classifier no matter what the advertised line says. This is an operator choice.

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
