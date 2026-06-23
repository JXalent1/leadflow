# Session 6 — kick-start prompt (deploy + pilot)

Two parts: a small **coding-agent task** (copy update + deploy config + verification, paste into
Claude Code) and an **operator runbook** (Vercel/Twilio dashboard steps + the live run, which you do
yourself). Full detail: `sessions/session-6.md`.

---

## Part 1 — paste into Claude Code (Task 0: copy + deploy prep)

```
Read `CLAUDE.md`, `handoff.md`, and `sessions/session-6.md` in full before writing any code.

Scope: Task 0 (approved copy) + deploy prep only. Do NOT trigger any real send.

1. Update lib/sms.ts to the APPROVED pilot message. Use JORDAN'S WORDING VERBATIM; the ONLY addition
   is "Reply STOP to opt out" at the end. Do NOT add a business name or change any other words.
   Message: "Hey [NAME] busy season is here, we are working close by if you were interested in window
   cleaning services at [ADDRESS]. Reply STOP to opt out"
   - Opt-out = "Reply STOP" (do NOT use "Type 2" — the system only suppresses on STOP-family keywords).
   - Pass contacts.address into renderMessage (add the param); title-case [ADDRESS] and [NAME]
     (county data is ALL CAPS — do not send caps). Blank/entity name => "Hey there".
   - Single-segment auto-fallback that drops ONLY the "at [address]" clause when the with-address
     version exceeds one GSM-7 segment: "Hey [NAME] busy season is here, we are working close by if
     you were interested in window cleaning services. Reply STOP to opt out"
   - Single variant (AB_VARIANTS=A => variant A is this message).
   - Update the campaign route to pass each contact's address into renderMessage.

2. Re-test: npm test must confirm every render ends with "Reply STOP to opt out." AND is single
   segment for the LONGEST real addresses in data/tallahassee_test_500.csv (load them in a test, or
   assert against the few longest). npm run build must pass.

3. Deploy config: confirm the API routes work within Vercel's function limits. Hobby caps ~60s, but
   the routes set maxDuration=300 — either add a vercel.json / note the Pro requirement, OR (preferred
   for the pilot) add a small `scripts/run-skiptrace.ts` + `scripts/run-scrub.ts` that call the lib
   functions in batches from the CLI against the prod DB, so trace/scrub never hit the serverless
   timeout. The send route is already batched/resumable.

4. Do NOT run any real trace/scrub/send. Update sms-copy.md is already done; just confirm it matches.

When done: show me the test output (single-segment proof incl. longest addresses + opt-out line
present), confirm npm run build passes, and tell me which trace/scrub run path you set up (batched
route vs local script). Update status.md + handoff.md.
```

---

## Part 2 — operator runbook (you do these; secrets stay with you)

**Deploy (safe, nothing sends):**
1. Vercel → Project → Settings → Environment Variables (Production): set a **real** `ADMIN_PASSWORD`
   (not `leadflow-dev`), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER=+18508213720`,
   `TRACERFY_API_KEY`, `TALAN_FORWARD_PHONE`, `BIZ_NAME=Talan Window Cleaning`,
   `SEND_TIMEZONE=America/New_York`, `AB_VARIANTS=A`, `SMOKE_TO_NUMBER`. Verify `DATABASE_URL` is
   present (Neon integration injects it).
2. Deploy (push to `main`). Confirm `/dashboard` loads behind the admin gate; it shows 500 contacts.
3. Twilio console → (850) 821-3720 → Messaging → "A message comes in" → POST
   `https://<your-domain>/api/webhook/twilio`. Set `TWILIO_WEBHOOK_URL` to that URL, redeploy.
4. **Self-test:** text the number from your phone — once "yes interested" (expect a lead + a ping to
   `TALAN_FORWARD_PHONE` + a dashboard row), once **STOP** (expect suppression + one confirmation).

**Then the gate checklist in `sessions/session-6.md`, then the live run (Phase B):**
trace (batches) → scrub → review eligible/dry-run → smoke send → confirm-gated paced send inside
10am–7pm ET → watch the dashboard → record delivery/reply/positive-reply/opt-out.

---

## After the pilot
Bring the four metrics back to Cowork and we'll read the results — decide on A/B for the next batch,
the full county pull, or copy tweaks based on the reply tone.
