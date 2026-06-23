# Session 6 — Deploy to Vercel + live pilot run

## Objective
Ship LeadFlow to production and run the real 500-record pilot end to end. This is the only module
where real money is spent and real cold SMS goes to real people, so it's split into a **safe deploy
phase** and a **gated live-send phase**. Capture the four metrics: delivery, reply, positive-reply,
opt-out.

## Task 0 — lock the approved copy into `lib/sms.ts` (do FIRST, before anything ships)
Approved pilot message — **Jordan's exact wording, verbatim**, with ONLY "Reply STOP to opt out" appended. Single message, no A/B. Do NOT add a business name or change any other words:
> Hey [NAME] busy season is here, we are working close by if you were interested in window cleaning services at [ADDRESS]. Reply STOP to opt out

Overflow fallback (drops ONLY the "at [address]" clause when the full version exceeds one segment):
> Hey [NAME] busy season is here, we are working close by if you were interested in window cleaning services. Reply STOP to opt out

- Update `lib/sms.ts`: make this the campaign message; **pass `contacts.address` into `renderMessage`**
  (the renderer currently takes name + zip — add address). Use the wording verbatim.
- **Opt-out = `Reply STOP`** — the only addition to Jordan's text. (Do NOT use "Type 2"; the system
  only suppresses on STOP-family keywords.)
- **Title-case** `[ADDRESS]` and `[NAME]` (county data is ALL CAPS — do NOT send caps). Blank/entity
  name → "Hey there".
- **Single-segment auto-fallback:** if the with-address version exceeds one GSM-7 segment, render the
  no-address fallback above so no eligible contact is skipped for length.
- Single variant: set `AB_VARIANTS=A` (variant A = this message).
- Re-run `npm test` (confirm every render ends with "Reply STOP to opt out" and is single-segment,
  including the longest real addresses in `data/tallahassee_test_500.csv`) and `npm run build`.
- `sms-copy.md` records this as the approved copy.

## Phase A — Deploy (safe; nothing sends)
1. **Set Vercel env vars** (Project → Settings → Environment Variables; Production). Enter them
   yourself — never share secrets in chat. Required: `DATABASE_URL` (already injected by the Neon
   integration — verify present), **`ADMIN_PASSWORD` (a real strong value — NOT `leadflow-dev`)**,
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER=+18508213720`, `TRACERFY_API_KEY`,
   `TALAN_FORWARD_PHONE`, `BIZ_NAME=Talan Window Cleaning`, `SEND_TIMEZONE=America/New_York`,
   `AB_VARIANTS=A`, `SMOKE_TO_NUMBER` (your phone). Set `SEND_RATE_PER_HOUR` /`SEND_WINDOW_*` if
   overriding defaults.
2. **Deploy** (push to `main` → auto-deploy). Confirm the build succeeds and `/dashboard` loads
   behind the admin gate at the production URL.
3. **Same DB:** the Neon DB is shared with dev, so the 500 contacts + schema are already there —
   verify the dashboard shows 500 total. (If Vercel uses a different `DATABASE_URL`, run
   `npm run schema` + `npm run import` against it first.)
4. **Twilio inbound webhook:** in the Twilio console, set the **Messaging** webhook for
   (850) 821-3720 → "A message comes in" → `https://<your-vercel-domain>/api/webhook/twilio` (HTTP
   POST). Then set the env var `TWILIO_WEBHOOK_URL` to that exact URL (for signature validation) and
   redeploy.
5. **Self-test the loop (no 500 touched):** from your own phone, text the number twice — once with
   an interested reply ("yes interested") and once with **STOP**. Confirm: the dashboard reply feed
   shows both; the interested one creates a lead + you get the SMS ping at `TALAN_FORWARD_PHONE`; the
   STOP suppresses you + sends exactly one confirmation. This proves the whole inbound loop live.

## Pre-send gate checklist (ALL true before Phase B)
- [x] Twilio off trial + (850) 821-3720 A2P 10DLC **approved** (confirmed 2026-06-22).
- [ ] `ADMIN_PASSWORD` in Vercel is a real strong value (not `leadflow-dev`).
- [ ] Talan has blessed the final wording (it goes out in his name).
- [ ] Tracerfy credits cover the run (~998 balance; ~trace-matches + matched-scrub).
- [ ] Self-test loop (Phase A step 5) passed.
- [ ] You accept the TCPA / Florida FTSA exposure for cold SMS (see `overview.md` compliance note) —
      this is the irreversible point.

## Phase B — Live pilot run (only after every gate is checked)
Run order (the deferred sequence). **Vercel Hobby caps function time (~60s), so trace/scrub the 500
in small batches via the `{limit}` param, or run them from a local script against the prod DB** — the
routes are idempotent/resumable, so batching is safe.
1. **Trace:** `POST /api/skiptrace {limit: 25}` first; check the dashboard (matches look sane, phones
   written), then continue in batches until all `pending` are traced. No-matches fail closed
   (suppressed).
2. **Scrub:** `POST /api/scrub` (in batches if needed). Suppresses DNC/litigator; sets
   `scrub_status`. Watch the suppressed count climb — that's the protection working.
3. **Review eligibility:** dashboard eligible count (expect well under 500 after no-matches + DNC) and
   a `POST /api/campaign {dryRun:true}` to confirm the count + that the single message renders right.
4. **Smoke send** once more to your own phone from prod config (`npm run smoke:twilio` or the
   dashboard) — confirm `delivered`.
5. **Real send:** inside the **10am–7pm ET** window, trigger the send with the dashboard's
   typed-CONFIRM modal (or `POST /api/campaign {confirm:true}`). It's paced + batched + resumable —
   run batches until complete, watching the dashboard. Suppressed/unscrubbed/opted-out are never
   selected (verified in the Session 3 review).
6. **Watch + capture:** replies land on the dashboard; STOP auto-suppresses + confirms; interested →
   lead + ping to Talan. Record delivery / reply / positive-reply / opt-out in `status.md`.

## Constraints / safety
- No path may text a suppressed, unscrubbed, opted-out, or already-sent contact — the eligibility
  query is the single gate (already reviewed). Do not relax it.
- Start small (the `{limit:25}` trace batch, watch the first send batch) before committing the rest.
- If reply tone shows confusion/anger about the address, pause and reassess before continuing.

## Acceptance
- App live on Vercel; `/dashboard` works; Twilio inbound webhook receiving (self-test passed).
- Pilot sent to the eligible subset within the send window; four metrics captured in `status.md`.
- `handoff.md` updated with results + any follow-ups (e.g., A/B for the next batch).
