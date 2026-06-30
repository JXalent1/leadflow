# Handoff

_For the next session — read this first._

## ⚠️ INCIDENT + fixture safety fix (2026-06-27)
**What happened:** the live-DB fixtures (`isolation`/`access`/`cockpit`/`auto-pause`/`passthrough`)
hardcoded `C2 = 2` as a disposable test tenant and ran `DELETE ... WHERE client_id = 2` UNCONDITIONALLY
in cleanup. After a REAL client #2 ("Jermey's Powerwashing") was onboarded, running those fixtures
**deleted his 2,900 contacts + campaigns/messages/leads/opt-outs** (his 15 paid `trace_jobs` survived
via FK). Recovery was via **Neon point-in-time restore** to ~2026-06-27 16:45 UTC.
**Fix applied (committed):** all 5 fixtures now use a high throwaway id `C2 = 900002` and call
`assertDisposableClientId(sql, C2, markerName)` from `scripts/fixture-safety.ts` **before** their
try/finally — it REFUSES to run if that id is occupied by a client the fixture didn't create (real
client) or if the id is < 100000. Cleanups now also drop `trace_jobs`/`scrub_jobs`. **Lesson: never run
a destructive live-DB fixture without checking it can't touch a real tenant.**


_Last updated: 2026-06-30 (Claude Code — Conversational-AI settings UI (per-client config) + responder
model swapped off Opus. Branch `build/ai-settings-ui`, PR into `main`. Config surface + model id only —
no responder/gate/send-path change, so no new agent-team review.)_

## ▶ Conversational-AI settings UI + model swap (2026-06-30) — PR open, NOT merged
The AI backend shipped OFF in PR #4; this adds the operator UI to configure + enable it per client (the
piece deferred from that build) and swaps the default model for cost. **CONFIG SURFACE + MODEL ID ONLY —
the responder logic, the deterministic STOP/"2"/suppression gate, and the send path are UNTOUCHED**
(front-end + config wiring; no new agent-team review needed).
- **UI:** new "Conversational AI" section in the client edit form, extracted into
  `components/client-ai-settings.tsx` so `client-form.tsx` stays under the cap (now 495 lines). Surfaces
  the **AI auto-reply** toggle (`ai_enabled`) + four free-text fields that only show when it's on:
  **Services offered** (`ai_services`), **Offer / hook** (`ai_offer`), **Rep name + tone** (`ai_persona`),
  **Service area** (`ai_location`); GHL-style short helper copy; an inline note that the server also needs
  `ANTHROPIC_API_KEY` + `AI_RESPONDER_ENABLED`. Minimal-premium styled (token classes; `accent-brand`).
- **Wiring fix (the non-obvious bit):** the `ai_*` fields already existed on the `Client` type +
  `updateClientConfig`/`CreateClientInput`, BUT the `PATCH /api/clients` route's `configFromBody` did NOT
  map them, so they never persisted from a request. Added the five `ai_*` keys to `configFromBody` (+ a
  `boolOrUndef` helper for `ai_enabled`). Also extended `ClientFormValues`/`EMPTY` (defaults
  `ai_enabled:false`, the rest null), `cockpit-view.tsx toFormValues` (so Edit prefills the saved values),
  and the form's submit payload. `ai_enabled` still ships **off** for every client; Talan unaffected.
- **Model swap:** `lib/ai-client.ts` default `claude-opus-4-8` → **`claude-sonnet-4-6`** (ample for SMS
  qualification, far cheaper + faster at volume). `claude-haiku-4-5-20251001` noted inline as the cheaper
  option. The `AI_RESPONDER_MODEL` env override path is unchanged.
- **Green:** `tsc` clean, `npm run build` green, `npm test` = **314** (unit suite unchanged — config/UI).
  **Live (Neon DB):** `npm run test:ai` = **20/20** (responder path intact, mocked Claude/Twilio,
  throwaway client self-cleaned, DB pristine). A scoped self-cleaning acceptance check (not committed)
  proved the round-trip: `updateClientConfig` persists all five `ai_*` fields → `getClientById` reads them
  back → `buildSystemPrompt` renders persona/services/offer/location → `ai_enabled` toggles back off.
  The other live fixtures touch backend logic this change doesn't alter — rerun before merge as usual.
- **NEXT:** open the PR into `main`; merge after PR #4 (the AI backend) lands. **Operator to enable a
  client:** set `ANTHROPIC_API_KEY` + `AI_RESPONDER_ENABLED=true` in Vercel (Production) + redeploy, then
  the client's settings → Conversational AI → fill services/offer/rep/area → toggle on; text the number.

_Earlier handoff entries below._

_Last updated: 2026-06-30 (Claude Code — Follow-up / re-engagement campaigns: re-text a prior
campaign's non-responders, REUSING the already-traced + already-clean phones (no re-trace, no re-scrub).
Branch `build/followup-campaigns`, PR into `main`, NOT merged — agent-team reviewed, Critical/High applied.)_

## ▶ Follow-up / re-engagement campaigns (2026-06-30) — PR open, NOT merged
Re-text a prior campaign's **non-responders** with a new short message, **REUSING the already-traced +
already-clean phones** — NO re-trace, NO re-scrub, **zero Tracerfy/scrub spend** (the biggest margin
lever; per `business-and-scaling-plan.md`). Target: Talan's ~4k contacts who got the first text but
never replied. **Send-path critical** — reuses the EXISTING eligibility / atomic-claim / suppression /
send path; never re-texts an opted-out/responded/lead/already-followed-up contact.
- **Audience is a PURE rule (`lib/followup-audience.ts`), unit-tested, single source of truth.** A
  contact is in the audience IFF: was_sent AND has phone AND not suppressed AND not replied (no inbound
  from that phone) AND not a lead AND not opted out (client-level `opt_outs`, last-10 — identical to
  eligibility) AND `prior_followups < maxFollowups`. `lib/followups.ts getFollowupAudienceIds` gathers
  the per-contact FACTS in ONE SQL query (the `replied`/`is_lead`/`opted_out`/`prior_followups`
  EXISTS/count subqueries) then applies `selectFollowupAudience` — eligibility is NEVER re-decided in
  SQL, so there's no second copy of the rule to drift.
- **Schema:** `campaigns.source_campaign_id` (nullable self-FK; NULL = a normal campaign → all existing
  campaigns byte-unchanged; surfaced so follow-ups read distinctly) + `campaigns.followup_round` with a
  partial UNIQUE index `(client_id, source_campaign_id, followup_round)` (the concurrency guard). Both
  idempotent adds.
- **Create (`createFollowupCampaign`):** INSERT a campaign (`source_campaign_id` set, `scrub_mode='none'`,
  status 'ready', `followup_round=N`) + ONE `INSERT … SELECT` that COPIES the source contact's
  phone/name/address with `skiptrace_status='matched'` + `scrub_status='clean'` + `send_status='not_sent'`
  + `suppressed=false`. NO Tracerfy/scrub client imported, NO `trace_jobs`/`scrub_jobs` row → ZERO
  credits. Default cap `DEFAULT_MAX_FOLLOWUPS=1` (operator-overridable to 2 etc.).
- **Send reuses the existing path** — seeded rows are ordinary not_sent/clean/matched contacts, so
  `getEligibleContacts` + atomic `claimForSend` + send-window + segment cap apply unchanged. **REVIEW
  FIX:** for a follow-up campaign the route passes `followUp=true`, and `getEligibleContacts` /
  `claimForSend` / `getSendProgress` then ALSO re-check opt-out + replied + lead EVERY batch (additive;
  `followUp` defaults false → normal campaigns byte-identical). So a STOP/reply/lead landing between
  seed and send still drops the contact. Trace/scrub stages are no-ops (matched/clean excluded;
  `scrub_mode='none'` passthrough).
- **API** `app/api/followups` (GET count + preview meta; POST create+seed — operator-only, client-scoped,
  source-ownership validated). **UI** `components/followup-panel.tsx` on the dashboard (audience count +
  live `renderMessage` preview + segment count → create + open; operator then runs the normal confirmed
  pipeline). Follow-up campaigns surface distinctly in the selector (`Follow-up` Badge + `↳`).
- **GOTCHA:** the default follow-up template carries NO opt-out line — `renderMessage` appends the
  per-client line (so a STOP-only client never gets a doubled line). Keep follow-up copy within the
  3-segment cap (the send path drains an over-cap message to 'failed').
- **NOTE (#15 dependency):** this was speced to build on #15 server-side sending, which is NOT yet merged
  on `main`. Until it lands, the follow-up drains via the EXISTING client-side pipeline driver (a tab is
  needed during the send). When #15 merges it drains server-side with NO change to this feature.
- **Green:** `tsc` clean, `npm run build` green, `npm test` = **314** (+pure audience suite). New
  **`npm run test:followup`** live-DB fixture (no real sends / no vendor spend) proves: audience
  exclusions; zero trace/scrub spend (no jobs row) + seeded send-ready; STOP-after-seed AND
  reply-after-seed excluded + `claimForSend(followUp)` refused; no double-send; idempotent. Requires
  `DATABASE_URL` — **operator runs `npm run schema` then `npm run test:followup` before merge** (no DB in
  the build env, so it wasn't run here; it touches only the new column + follow-up paths).
- **AGENT-TEAM REVIEW DONE (3 read-only reviewers):** no-spend **HOLDS** (no Critical/High); no-double-send
  + invariants **HOLD**. **1 HIGH fixed** (replied/lead seed-time-only → now re-checked at send via
  `followUp`). **1 MEDIUM fixed** (concurrent create double-seed → `followup_round` unique index). Logged
  (no change): dup-phone-divergent-scrub on source (rare, pre-existing); stale DNC on a reused phone is
  BY DESIGN (no re-scrub; STOP/opt-out still honored); free orphan-job re-ingest from siblings (no spend).
- **NEXT:** open the PR into `main`; run `test:followup` with Neon creds; review + merge after #15.

_Earlier handoff entries below._

_Last updated: 2026-06-29 (Claude Code — UI/UX overhaul: a minimal-premium neutral design system
supersedes the "Fresh"/teal R1 look across EVERY screen; accent moved teal→indigo, still a re-themable
`--brand` token; FRONT-END only.)_

## ▶ UI/UX overhaul — minimal-premium across all screens (2026-06-29) — DONE (on `build/ui-overhaul`, PR not merged)
Replaced the "Fresh" teal/rounded R1 look (read cheesy) with a restrained, neutral, data-forward,
premium system (Linear / Stripe / Vercel). **PRESENTATION ONLY — NO app logic / routes / queries /
suppression / eligibility / send path / auth / DB / component props changed.** Runs in parallel with
the conversational-AI prompt (backend-only; no file overlap).
- **Neutrals are now TOKENS.** `app/globals.css :root` adds `--surface-0` (page) / `--surface-1`
  (inset/hover) / `--surface-2` (cards) / `--border` / `--border-strong` / `--text-primary` /
  `--text-secondary` / `--text-muted`; `tailwind.config.ts` maps `surface` / `hairline` / `ink` color
  families to them. Chrome uses `bg-surface` / `bg-surface-sunken` / `bg-surface-muted` / `border`
  (now a 0.5px hairline, default color `var(--border)`) / `border-hairline-strong` / `text-ink` /
  `text-ink-muted` / `text-ink-subtle`. ZERO literal slate/stone/neutral classes remain.
- **Accent moved teal→indigo, STILL A TOKEN (load-bearing for white-label).** `--brand` `#4f46e5` /
  `--brand-strong` `#4338ca` / `--brand-tint` `#eef2ff` / `--brand-tint-fg` `#4338ca` / `--brand-fg`
  `#fff`. Every kit component reads `bg-brand`/`text-brand-strong`/`ring-brand-tint`, so **overriding
  `--brand*` on a wrapper re-themes the subtree** — proven in compiled CSS (`.bg-brand{background-color:
  var(--brand)}` etc., `:root` holds the indigo default); the client portal's hero metric, progress
  fill, "met" chip, target-met note + tel links are all brand-token-driven, so a per-client `--brand`
  override flips the portal accent with no component change.
- **GOTCHA (carried from R1):** `--brand*`/surface/ink are hex CSS vars, so Tailwind `/opacity`
  modifiers do NOT apply. Modal backdrops therefore use `bg-black/40` (NOT `bg-ink/40` — that renders
  opaque); the app header is solid `bg-surface` (not `bg-surface/85`). Don't reintroduce `/opacity` on
  a token utility expecting alpha.
- **Shape/type:** `borderWidth.DEFAULT='0.5px'` (hairlines everywhere incl. `divide-y`); radii remapped
  in config — `rounded-2xl`=10px (cards), `rounded-lg`/`rounded-xl`=8px (controls); **no shadows**
  (every `shadow*` removed; only the focus ring); Inter **two weights** (`font-semibold`/`font-bold`→
  `font-medium`); **sentence case** (all `uppercase`/`tracking-wide` labels removed); tabular-nums on
  figures.
- **Density / new primitive:** `components/ui/status-dot.tsx` (a small colored dot + muted label,
  tone-based, brand tone re-themable) replaces loud status pills in dense lists/tables. The wordmark
  dropped the teal droplet for a restrained neutral mark (ink square + flow stroke).
- **Cockpit re-layout:** `components/cockpit-view.tsx` is now a **dense clients table** (a Card holding
  hairline-divided clickable rows) — columns Client (monogram + name + days-left) / Pace (StatusDot) /
  Leads·cycle (thin ProgressBar + N/T) / Sent / Opt-out, with a secondary line carrying reply-rate +
  auto-pause + the Edit launcher + CockpitBilling. Behind-pace-first sort + per-row click-through to
  `/dashboard?clientId=N` unchanged (the row is an `<a>`; Edit/billing stop-propagate, same pattern as
  the old Card).
- **Restyled (all SAME props/behavior):** kit `components/ui/*` (button/card/stat-tile/badge/field/
  toggle/progress-bar/app-header/wordmark + new status-dot); login; cockpit (`page.tsx`,`cockpit-view`,
  `cockpit-billing`); dashboard (`dashboard-client`,`count-cards`,`send-progress`,`pipeline-runner`,
  `campaign-controls`,`campaign-bar`); inbox (`components/inbox/*`); portal (`app/client/page.tsx`,
  `portal-client`); `client-form`; `leads-table`/`reply-feed`/`opt-out-list`.
- **Green:** `tsc` clean, `npm run build` green, `npm test` = **258**. The live-DB fixtures
  (`test:isolation`/`access`/`cockpit`/`auto-pause`/`passthrough`/`optout`/`forward`) need Neon creds
  (absent in the build session) — they assert backend logic this change didn't touch; rerun before merge.
- **Note:** the portal is white-label-READY (tokens + mechanism), but `lib/portal.ts` does NOT expose a
  per-client brand hex, so no `--brand` data-wiring was added (would be a query change, out of scope).
  Wiring a per-client accent from `clients.branding` onto a `style={{['--brand']: hex}}` wrapper is a
  small follow-up when that data is plumbed into `getPortalData`.

_Earlier handoff entries below._

_(R1 entry, 2026-06-28 — the "Fresh" teal/warm/rounded design system replaced the V7 indigo look across
login/cockpit/dashboard; superseded by the overhaul above.)_

_Last updated: 2026-06-29 (Claude Code — Conversational AI lead-qualifier BACKEND built on
`build/ai-responder`; PR open into `main`, NOT merged — awaiting the 3-reviewer compliance/correctness/
security pass. Runs in parallel with the UI-overhaul stream; no file overlap.)_

## ▶ Conversational AI lead-qualifier (GHL-style) — BACKEND, review-gated (2026-06-29) — PR OPEN, NOT MERGED
A new autonomous OUTBOUND path (Lance's GoHighLevel SMS AI): read **intent** (not keywords), reply fully
human, qualify, set the "we'll reach out" expectation, capture + forward hot leads — **never texting an
opted-out/suppressed contact.** **BACKEND ONLY** — no UI/components touched (the AI config UI ships with the
UI-overhaul stream; until then the operator flips `clients.ai_enabled` via `updateClientConfig`).

- **Compliance ordering is load-bearing.** `lib/inbound.ts processInbound` is unchanged through the
  opt-out gate: the deterministic `isOptOut(body) || isConfiguredOptOut(body, keyword)` check + the
  `logInboundOnce` dedupe gate run FIRST. The AI is delegated ONLY *after* both — and only when
  `contact !== null` (we never text a number we don't store). So the AI **never runs on an opted-out
  contact** and **fires at most once per inbound** (a deduped Twilio retry returns before the AI).
- **The deterministic gate is NEVER model-dependent.** STOP / "2" / suppression are pure code in
  `lib/classify.ts` + `lib/inbound.ts`; the LLM only handles non-opted-out inbounds.
- **Every AI reply reuses the existing suppression gate.** `lib/ai-responder-wire.ts` builds `sendReply`
  as: re-load the contact (`getContactById`) → `isPhoneOptedOut` → `replyRefusalReason` → refuse, else
  `sendOne(contact.phone, …)` to the **STORED phone only** (never a model-supplied number) → log
  `status='ai_reply'`. At most ONE reply per inbound (no double-text).
- **Fail-safe.** `processInbound` wraps `runAiResponder` in try/catch; on `null` (e.g. quiet hours) or
  ANY throw it falls back to the keyword path. The inbound is already logged, so a fallback never loses
  the lead and never crashes the webhook (route still returns 200/TwiML).
- **Behavior knobs:** auto-sends gated to the client send window; turn cap (default 5, derived from the
  `messages.status='ai_reply'` count); 3-strike dismiss for non-serious (`contacts.ai_strikes`); a
  qualified lead (interest + service + wants-call) → **exactly one** hot lead (`createLead`) + **one**
  `forwardLead` carrying the model's rich summary → `ai_status='handed_off'` (AI stops; a human owns it).
- **Files:** `lib/ai-responder.ts` (PURE core + `buildSystemPrompt`, DB/SDK-free → unit-testable),
  `lib/ai-client.ts` (real Claude call, `@anthropic-ai/sdk`, structured JSON output, effort low,
  `claude-opus-4-8`), `lib/ai-db.ts` (per-contact AI state + history/turn-count, client-scoped),
  `lib/ai-responder-wire.ts` (assembles real deps; `aiResponderGloballyEnabled()` gate). The webhook's
  `buildDeps` wires `runAiResponder` ONLY when `AI_RESPONDER_ENABLED` && `client.ai_enabled`.
- **Schema (idempotent, in `db/schema.sql`):** `clients.ai_enabled/ai_services/ai_offer/ai_persona/
  ai_location`; `contacts.ai_status/ai_strikes`. `lib/clients.ts` extended (Client type, `toClient`,
  `CreateClientInput`, `updateClientConfig` setter). Run `npm run schema` before enabling.
- **Env:** `ANTHROPIC_API_KEY`, `AI_RESPONDER_ENABLED` (global kill switch — must be `"true"`),
  optional `AI_RESPONDER_MODEL` (default `claude-opus-4-8`), `AI_RESPONDER_MAX_TURNS` (default 5).
  `ai_enabled` ships **OFF for all clients** → Talan byte-unchanged.
- **Green:** `tsc` clean, `npm run build` green, `npm test` = **279** (+21 unit: pure-core scenarios +
  `processInbound` wiring). New **`npm run test:ai`** live-DB fixture (MOCKED Claude + Twilio — no spend,
  no sends; uses `createClient` for a throwaway tenant, deletes only what it created). Not run locally
  (no DB creds in this session) — the operator runs it after `npm run schema`.
- **REVIEW DONE (3 read-only reviewers — compliance / correctness / security):**
  - **Security:** claim holds (stored-phone-only, model can't control the destination, no secrets
    logged, multi-tenant scoped). 1 Low — the model-generated `summary` is the body of the operator
    ping (operator already receives the lead's reply text; can't change the `to` or reach the prospect). Logged.
  - **Compliance:** hard "never *texts* an opted-out contact" holds (the `sendReply` gate fail-closes).
    Medium — the AI was still *invoked* (and could create/forward a lead) for a PRE-EXISTING opt-out.
    **FIXED:** `runAiResponder` now short-circuits on `input.suppressed` → returns null → defers to the
    keyword path; the wire computes `suppressed` from the freshest `getContactById`+`isPhoneOptedOut`.
    So the AI literally never runs on an opted-out contact (+ saves a Claude call). Low TOCTOU logged.
  - **Correctness — 1 HIGH, FIXED:** a post-commit throw (`markHandedOff`/`sendReply` raw `sql`) in the
    qualified branch propagated to `processInbound`'s catch → keyword fallback → **duplicate lead +
    forward in one request**. **FIX:** the pure core wraps EVERY post-decision effect in `safe()`
    (logs + continues); only a pre-side-effect `classify` throw propagates. Once the lead is created
    the outcome stays `ai_lead`, so the caller never falls back. Engaged-branch `sendReply` errors are
    swallowed too (no spurious keyword lead). Logged: handoff-durability degrades to baseline
    keyword behavior (already multi-lead-per-inbound); pre-existing keyword lost-lead on a crash
    between log-commit and lead-commit. Dedupe gate / single-reply / turn-cap (exactly 5) all solid.
  - Re-verified: `tsc`/build green, `npm test` = **283** (+4 — suppression short-circuit + 3 post-side-
    effect-no-propagation tests).
- **NEXT:** merge PR #4 into `main` (review passed, Critical/High applied). Operator sets
  `ANTHROPIC_API_KEY` + `AI_RESPONDER_ENABLED` in Vercel + runs `npm run schema`; `ai_enabled` stays
  OFF until a client opts in.

_Last updated: 2026-06-29 (Claude Code — skip-trace reliability: retry/backoff on transient Tracerfy
errors + a graceful resumable pause in the driver instead of a dead `skiptrace_failed`. Branch
`build/trace-resilience`, PR into `main`, NOT merged.)_

## ▶ Skip-trace reliability — retry/backoff + don't halt on a transient error (2026-06-29) — PR open, not merged
The trace died mid-run with `skiptrace_failed` on the FIRST transient Tracerfy error (429/timeout/5xx),
usually after ~10 rapid 200-record batches, so the operator had to re-click repeatedly — even though the
run is fully resumable. It now rides through transient errors on its own. **TRACE PATH ONLY** — the
fail-closed verdict (no-match → `no_match`/suppress), the credit pre-flight, the cost model, the
orphaned-job recovery contract, and the send / suppression / inbound-webhook paths are all UNTOUCHED.
- **New `lib/retry.ts` (pure):** `withRetry(fn, opts)` — capped exponential backoff + **equal jitter**
  (`cap/2 + rand*cap/2`, bounded `[cap/2, cap]`), default **4 attempts**, injectable `sleep`/`rng` so
  tests are instant + deterministic. `isTransientError(err)` — a `TracerfyError` with no status
  (network/abort) or 408/429/≥500 → transient; any other 4xx → terminal; a **non-Tracerfy error →
  terminal** (so a real bug or `InsufficientCreditsError` is never retried/masked). `backoffDelay` is
  exported + unit-tested. **GOTCHA:** retry.ts imports `TracerfyError` from tracerfy.ts — keep that
  one-way (tracerfy.ts must NOT import retry.ts or you get a cycle).
- **`lib/skiptrace.ts`:** the `getCredits` / `submitTrace` / `getTraceResults` calls are wrapped in
  `withRetry(..., traceRetry(label, retry))`. **Every external collaborator is now injectable** via a new
  `TraceDeps` object (DB writers + the Tracerfy client), defaulting to the real impls — same DI pattern as
  `forwardLead`'s `deps`, so the route still calls `traceBatch(clientId, {...})` (unchanged) and tests pass
  fakes. **Poison-record screen:** `isTraceable(c)` (exported) is false for a blank/whitespace address (it
  can never match back); such records are **suppressed fail-closed (`no_match`) BEFORE any submit** and the
  credit pre-flight + submit run only on the traceable remainder, so one bad input can't waste a credit or
  block the batch. Orphaned-`submitted`-job recovery (`ingestOutstandingJobs`) still runs FIRST and is
  byte-unchanged; recovery is a free re-read → **never re-charges**. 333 lines (< 500).
- **`app/api/skiptrace/route.ts`:** its 502 now carries `retryable: isTransientError(err)` so the driver
  distinguishes a transient rate-limit from a genuine fault. The 402 credit path + 401/404 are unchanged.
- **`components/pipeline-runner.tsx`:** ONLY the skip-trace stage changed (scrub + send byte-unchanged, to
  respect the send-path boundary). `postTraceBatch` auto-retries a transient batch failure (4 tries,
  1s→2s→4s→8s) keyed off the route's `retryable` flag (or a raw network/gateway status); if it still can't
  clear it sets `paused` and shows an **info** message ("…temporarily unavailable… nothing was
  double-charged — click Resume") with a **Resume** button (calls `runPipeline` directly, no re-confirm).
  Never a dead `skiptrace_failed`. 425 lines (< 500).
- **Did NOT** do the optional server-side trace drain (tab-independent) — it's a larger change (durable
  queue/cron) and was deferred. **Charge-safety:** the only charging call is `submitTrace`; the dominant
  transient (429) is a rejected request → no queue, no spend → safe to retry. The lone residual ("submit
  succeeded server-side but the response was lost") already orphaned an untracked paid queue before this
  change and is not worsened in cost terms by a bounded retry.
- **Green:** `tsc` clean, `npm run build` green (needs a well-formed `DATABASE_URL` at page-data
  collection — neon is lazy, a dummy `postgresql://u:p@h.tld/db` suffices, no connection), `npm test` =
  **277** (+19). New tests: `lib/retry.test.ts` (backoff/classifier/withRetry, pure) and
  `lib/skiptrace.test.ts` (Tracerfy + DB fully MOCKED via `TraceDeps` — no DB, no spend; proves
  transient-retried-then-succeeds with ONE queue/no-double-charge, transient credit-read recovers, credit
  shortfall stops clean with nothing billed, poison skipped + run continues, **resume re-ingests an orphaned
  `submitted` job with no re-charge**, idempotent 2nd run, terminal 4xx not retried). **GOTCHA (tests):**
  `skiptrace.test.ts` sets `process.env.DATABASE_URL ||= "postgresql://…"` then pulls in skiptrace via
  `require(...) as typeof import(...)` (NOT a static/`await import`) — the test runner is CJS output, so
  top-level await fails and a hoisted static import would hit db.ts before the dummy URL is set.
- **Live-DB fixtures NOT run here (no `DATABASE_URL`):** `test:isolation`/`access`/`cockpit`/`auto-pause`/
  `passthrough`/`optout`/`forward`. They touch none of the changed trace-path files and `skiptrace.ts`'s
  new params are defaulted (backward-compatible), so they stay green — **re-run them where the DB is
  configured before merging.**

_Last updated: 2026-06-28 (Claude Code — Revamp R1: the "Fresh" teal/warm/rounded design system replaces
the V7 indigo look across login/cockpit/dashboard; the accent is a re-themable `--brand` CSS-var token.)_

## ▶ Revamp R1 — "Fresh" design system (2026-06-28) — DONE + DEPLOYED
Visual-only retheme of the shared kit + login/cockpit/dashboard from the V7 **indigo/slate** look to the
**"Fresh"** identity: warm, rounded, friendly, **teal**. **NO app logic / routes / queries / suppression /
eligibility / send path / auth / component props changed — presentation only.** This is R1 of 3
(R2 = inbox + campaign/run screens; R3 = white-label client portal).
- **The accent is a TOKEN, not a value (load-bearing for R3).** `app/globals.css :root` defines
  `--brand` `#1d9e75` / `--brand-strong` `#0f6e56` / `--brand-fg` `#fff` / `--brand-tint` `#e1f5ee` /
  `--brand-tint-fg` `#0f6e56`; `tailwind.config.ts` maps a `brand` color family to those vars. Every kit
  component uses `bg-brand` / `text-brand-strong` / `ring-brand-tint` / `hover:bg-brand-strong` —
  **never a literal teal**. **Overriding `--brand*` on any wrapper element re-themes its whole subtree**
  with no component change → that's how R3 will white-label per client. Proven in the compiled CSS (every
  `brand` utility resolves to `var(--brand*)`; `:root` holds the teal defaults). **GOTCHA:** these are hex
  vars, so Tailwind `/opacity` modifiers (`text-brand-strong/80`) do NOT work on brand utilities — use
  solid brand classes (I hit + removed one).
- **Shape/type/neutrals:** neutrals **slate → warm stone** (kit + the 3 screens; out-of-scope inbox/portal
  still use slate until R2/R3); cards **16px** `rounded-2xl`, controls `rounded-xl`; Inter kept but **two
  weights (400/500)** (`font-semibold`→`font-medium`) and **sentence case everywhere** (StatTile/Health/
  cockpit-status labels lost their `uppercase`); new teal **droplet** wordmark + a `SparkleIcon` used as
  the leading **service icon** on each cockpit client card (a brand-tinted tile — there's no service-type
  field, so it's a neutral white-label-friendly mark, not data).
- **Kit changes keep the SAME props** (`components/ui/*`): Button (primary = teal solid), Card/CardHeader,
  StatTile (sentence-case label + tinted `good` = brand), **Badge `indigo` tone → `brand`** (updated its
  only 2 consumers: cockpit-view, dashboard-client), Field/Input/Select (teal focus ring), **ProgressBar
  `indigo`→`brand`** (default + send-progress), **SegmentedToggle** active = `brand` but **`indigo` kept as
  a legacy alias mapping to the same teal** so the out-of-scope `campaign-bar.tsx` (`activeTone:"indigo"`)
  still compiles, AppHeader. Global focus ring is now `--brand`.
- **Drive-by fixture fix (pre-existing RED on clean HEAD):** the 2026-06-27 INCIDENT-fix moved the
  throwaway tenant to `C2 = 900002`, but 4 assertions in `isolation`/`access` fixtures still compared the
  *owned/resolved* client id against the old literal `2` (real client Jermey) → 2+2 failures. Fixed `2`→`C2`
  on exactly those (`isPhoneOptedOut`/`findContactByPhone` in isolation; the resolve-to-own-client checks in
  access). The literal `2`s that are arbitrary *requested* ids were already correct and left alone.
- **Green:** tsc clean, `npm run build` green, `npm test` = **258**, isolation/access/cockpit/auto-pause/
  passthrough/optout/forward ALL pass. Deployed `vercel --prod`.
- **R2 next:** restyle `/inbox` (`components/inbox/*`) + the campaign/run detail screens to Fresh (same
  token system; switch their slate→stone, indigo→brand). **R3:** white-label client portal (`/client`) —
  set `--brand*` per client on a wrapper + per-client logo/name; decide in-app branding vs. custom domain,
  logo upload vs. monogram.

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
