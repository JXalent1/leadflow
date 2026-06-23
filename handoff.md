# Handoff

_For the next Cowork session — read this first._

_Last updated: 2026-06-23 (Claude Code — Module 7 BUILT + agent-team review-clean)_

## TL;DR
LeadFlow is a self-hosted SMS lead-gen tool for home-service businesses. First client is Talan (Tallahassee window cleaning). **Modules 1–5 + 7 are built and Module 7 is agent-team review-clean; Session 6 Task 0 (copy locked) done; Vercel env vars set.** Module 7 added the missing piece — an in-app **inbox** with conversation threads, a **reply box** that texts homeowners back from the campaign number (admin-gated, **suppression-checked, stored-phone-only, logged**), and **`leads.status`/`notes`** tracking. The review confirmed both adversarial claims HOLD (no arbitrary-number send; no reply to an opted-out person) with no Critical; 2 High applied + re-verified. **Remaining: Session 6 (deploy + self-test + live pilot).**

## ▶ Immediate next: Session 6 (deploy + pilot)
Run `sessions/session-6-prompt.md`. Module 7 is in and review-clean, so the pilot ships with reply + lead tracking. (Full runbook below.)

## ✅ Session 7 review pass — COMPLETE (2026-06-23)
A 3-reviewer read-only agent team (security / compliance / correctness, Sonnet) audited the reply/inbox path. **No Critical.** Both load-bearing claims HOLD: "the reply endpoint can't text an arbitrary number" (destination is only ever the DB row's `phone`, loaded by a validated integer `contactId`) and "a reply can never reach an opted-out person" (the gate is `await`ed before `sendOne`; `replyRefusalReason` checks `contacts.suppressed` AND the `opt_outs` row independently, catching both crash directions + normalization mismatch + null/missing + coercion). **Applied 2 High in `lib/inbox-db.ts` `getInboxThreads`:** H1 — order by `COALESCE(lm.created_at, l.created_at)` (lead-only/no-message contacts sort by recency); H3 — `needs_reply = inbound AND NOT suppressed` (raw flag never claims an opted-out contact needs a reply). Re-verified: 153 tests + build + a DB fixture (suppressed-STOP → `needs_reply=false`, clean inbound → `true`). **Logged/accepted (not actioned):** H2 no server-side reply idempotency (at worst a duplicate to a non-suppressed person — never a TCPA break; client guard suffices for the single-operator MVP), the inherent TOCTOU STOP/reply race, notes `""`-vs-`NULL`, failed-bubble prominence, `getThread` round-trips, inbox-page raw-error echo. See `overview.md` + `status.md` for the full list.

## ⚡ What changed this session (Session 7 / Module 7) — NO real send triggered
- **Schema:** `leads.status text NOT NULL DEFAULT 'new'` (new|contacted|quoted|scheduled|won|lost) + `leads.notes text`, idempotent `ALTER … ADD COLUMN IF NOT EXISTS`. **Applied via `npm run schema`** (verified live against the Neon DB).
- **`POST /api/reply` (compliance-critical):** admin-gated (401 unauthed). Body `{contactId, body}` — **never accepts a phone from the request**; loads the contact and sends ONLY to `contact.phone`. **Refuses with 422 `recipient_suppressed`** when the contact is missing / has no phone / `suppressed=true` / has an `opt_outs` row (fail closed). On pass: `sendOne(contact.phone, body)` → `recordMessage(outbound)`; failed sends are still logged. NOT blocked by the send window (1:1 reply is conversational); multi-segment allowed. The gate is a pure, unit-tested `lib/reply.ts` `replyRefusalReason(contact, optedOut)`.
- **`POST /api/leads`:** admin-gated; `{leadId, status?, notes?}` → `setLeadStatus`; status validated against the allowed set (400 `invalid_status`); returns the updated lead.
- **`GET /api/inbox` (read-only, admin-gated):** the conversation list, or `?contactId=` for one full thread — used by the client to refresh after a reply.
- **DB helpers** in new **`lib/inbox-db.ts`** (split out so `lib/db.ts` stays ≤500 lines): `getInboxThreads`, `getThread`, `getContactById`, `isPhoneOptedOut`, `setLeadStatus`. `LEAD_STATUSES` lives in pure **`lib/lead-status.ts`** (so client components import it without bundling the Neon driver).
- **UI `/inbox`** (admin-gated; unauthed → 307 `/`) + `components/inbox/*` (`inbox-client`, `conversation-list`, `thread-view`, `reply-box`, `lead-status`): conversation list (name, last-message preview, time, **needs-reply** badge; suppressed marked + reply box disabled), thread view (inbound vs outbound distinct) with reply box (segment count shown, never blocks) + lead status dropdown/notes. **Dashboard wiring:** Inbox link in the header; the leads table shows `status` and each row links to its `/inbox?contact=` thread.
- **Proof (no real person texted):** `npm run build` passes (`ƒ /api/{reply,leads,inbox}` + `ƒ /inbox`, 3.6 kB client — no DB driver in the browser bundle); `tsc --noEmit` clean; **153 unit tests green** (+7 `lib/reply.test.ts`); **live HTTP** against the dev server — unauthed `/inbox`→307, unauthed `POST /api/{reply,leads}` + `GET /api/inbox`→401; with the admin cookie, reply to an inserted **suppressed fixture → 422 `recipient_suppressed` (sendOne never reached)**, missing contact → 422, `POST /api/leads` valid → 200, invalid status → 400. All fixtures cleaned up. All files ≤500 lines.

## Compliance invariants Module 7 holds (it added a new send path — read this)
- **The reply endpoint refuses any suppressed/opted-out contact** — same "honor STOP" guarantee as the campaign blast, now on the manual path. The server refusal (`lib/reply.ts` → 422) is the real gate; the disabled UI box is the second layer.
- **Replies go ONLY to the stored `contact.phone`** — the request body's phone (if any) is ignored. This is the single defense against the tool being used to text arbitrary numbers.
- **Every outbound reply is logged to `messages`** (success and failure). Every new endpoint is admin-gated.
- Suppression — not the send window — is the gate for a 1:1 reply (deliberate; see overview.md decision).

## Modules 1–5 (still true — unchanged this session)
- **Module 1** — Next.js skeleton, Postgres schema, CSV importer, admin gate. `contacts` holds all 500 pilot rows (no phones yet — trace deferred).
- **Module P** — `lib/classify.ts` + `lib/sms.ts` (approved copy locked in variant A; `AB_VARIANTS=A`).
- **Module 2 (Tracerfy)** — `lib/tracerfy.ts`, `/api/skiptrace`, `/api/scrub`; smoke gate passed live on record #1. **Full 500 trace+scrub DEFERRED to pilot time.** CLI runners `npm run trace` / `npm run scrub` are the preferred pilot path (batched, idempotent, resumable, no function timeout).
- **Module 3 (Twilio send engine)** — paced/resumable send, `scrub_status` guard, atomic claim, A/B, send window. Agent-team reviewed. Smoke delivered live.
- **Module 4 (inbound webhook)** — STOP + interest triage + lead ping, behind Twilio signature validation. Agent-team reviewed.
- **Module 5 (dashboard UI)** — admin-gated `/dashboard`: count cards, send-progress, reply feed, leads table, opt-out list, control buttons (typed-CONFIRM modal before a real send). Read-only.

## Session 6 (deploy + live pilot) — runbook, runs AFTER the Session 7 review
Full detail in `sessions/session-6.md` + `-prompt.md`. Order:
0. ✅ **Task 0 (copy) — DONE.** Approved copy locked in `lib/sms.ts` variant A. Opt-out is **Reply STOP**.
1. **Vercel env** — real `ADMIN_PASSWORD` (not `leadflow-dev`), all `TWILIO_*`, `TRACERFY_API_KEY`, `TALAN_FORWARD_PHONE`, `BIZ_NAME=Talan Window Cleaning`, `SEND_TIMEZONE=America/New_York`, `AB_VARIANTS=A`; confirm `DATABASE_URL` is injected by Neon. Deploy.
2. **Twilio inbound webhook** — point the Messaging webhook at `https://<app>/api/webhook/twilio`; set `TWILIO_WEBHOOK_URL`; redeploy. **Self-test:** text the number (interested + STOP) → confirm the dashboard, the lead ping, AND that the new inbox thread shows it and you can reply from `/inbox`.
3. **Gate checklist** (Twilio off-trial+10DLC ✓; real admin pw; Talan wording blessing; credits; self-test pass; accept TCPA/FTSA exposure), then **run order on the real list** (idempotent, batched, resumable): **`npm run trace -- --max=25`** → check dashboard → **`npm run trace`** (rest) → **`npm run scrub`** → **dry-run** (`POST /api/campaign {dryRun:true}`) → smoke send to your own phone → **Start send** (typed-CONFIRM modal, inside 10am–7pm ET) → watch the dashboard + work the inbox.
4. Capture the four pilot metrics: delivery, reply, positive-reply, opt-out.

## Gotchas the next session must know
- **`/inbox` and `/dashboard` show empty/eligible=0 right now** — correct: the full 500 trace+scrub is deferred, so no contact has a phone, no inbound exists yet. After the Session 6 trace+scrub + first replies, the inbox populates.
- **The reply box texts a real homeowner** — it's the one place in the UI that sends to a non-Talan number. The suppression refusal + stored-phone-only rules are why that's safe; keep them honest (that's what the Session 7 review checks).
- **Shared admin password for Talan (MVP)** — Talan uses the same `ADMIN_PASSWORD` for the dashboard AND the inbox. Per-user login still deferred.
- **`npm run schema` already applied** — `leads.status`/`leads.notes` are live, plus the prior unique indexes (`messages(twilio_sid)`, `opt_outs(phone)`).
- **No pause/stop endpoint** — the send model is "run a batch / re-run to continue" (atomic claim keeps it safe).
- **To screenshot the live UI:** `npm run dev`, log in with `ADMIN_PASSWORD`, open `/dashboard` → Inbox →. (A browser was holding the chrome-devtools MCP profile in a prior session; this session verified via served-page + curl.)

## Open questions / pending input
- **Talan's cell** (`TALAN_FORWARD_PHONE`) for the lead ping — own phone works as a stand-in to test.
- **Per-user login for Talan** vs the shared admin password — shared is fine for the pilot.
- **Prod admin password** + **Twilio/Tracerfy env in Vercel** before public.
- **Secret hygiene** — Tracerfy key + Twilio token shared in chat in plaintext; rotate after the pilot.

## Compliance reminder (unchanged, hard requirements)
Never send to a scrub-flagged, no-match, opted-out, or unscrubbed number; honor STOP instantly and permanently. The eligibility query (`suppressed=false AND scrub_status='clean'`), the atomic claim, the `opt_outs` table, Module 2's fail-closed scrub, Module 4's signature gate + STOP suppression, and **Module 7's reply refusal (`replyRefusalReason` → 422, stored-phone-only)** all exist for exactly this — keep them honest.
