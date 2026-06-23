# Session 3 — kick-start prompt

Paste into **Claude Code** (project root) to build Module 3. Full spec: `sessions/session-3.md`.
Single focused **spine** session (no agent team for the build). After it passes its smoke gate,
run the parallel review pass: `sessions/session-3-review.md`.

---

## Before you paste this

1. **Twilio creds in `.env.local`** (gitignored — never commit, never put in the prompt):
   ```
   TWILIO_ACCOUNT_SID=<your SID>
   TWILIO_AUTH_TOKEN=<your token>
   TWILIO_FROM_NUMBER=+18508213720
   SMOKE_TO_NUMBER=<your own mobile, +1XXXXXXXXXX>   # where the smoke test sends
   SEND_RATE_PER_HOUR=60                              # optional, defaults ~60
   ```
2. **No real send happens this session** — the gate is one smoke message to your own phone. The 500
   run is deferred to pilot time.
3. **Two send-time gates to remember (not needed to build, required before the real campaign):**
   confirm the Twilio account is upgraded from trial with A2P 10DLC approved on (850) 821-3720, and
   get Talan's sign-off on the copy in `sms-copy.md`.

---

## The prompt (copy everything in the block below)

```
Read `CLAUDE.md`, `handoff.md`, and `sessions/session-3.md` in full before writing any code.

Your scope is ONLY Module 3: the paced Twilio send engine + suppression/eligibility. Do NOT:
- Build inbound handling, STOP, reply triage, or lead forwarding (Session 4).
- Build dashboard UI (Session 5).
- Add number rotation or any multi-number logic.
- Re-implement message rendering — IMPORT it from lib/sms.ts (renderMessage, withinSingleSegment).
- Create any file over 500 lines.
- Send anything to the real list. The only send this session is ONE smoke message to SMOKE_TO_NUMBER.

Do these in order:

1. scrub_status guard (FIRST). Add `scrub_status text NOT NULL DEFAULT 'pending'` to contacts
   (values pending|clean|flagged) in db/schema.sql (ALTER ... ADD COLUMN IF NOT EXISTS), apply via
   `npm run schema`. Update app/api/scrub/route.ts to write scrub_status='clean' on a clean verdict
   and 'flagged' on any flag / suppress / scrub_error. Update getEligibleContacts() in lib/db.ts so
   eligibility is: phone IS NOT NULL AND suppressed=false AND scrub_status='clean' AND
   send_status='not_sent'. A matched-but-not-yet-scrubbed contact must NOT be eligible.

2. lib/twilio.ts — Twilio SDK client from env (support TWILIO_FROM_NUMBER or a
   TWILIO_MESSAGING_SERVICE_SID, prefer the messaging service if set). sendOne(to, body) wrapped in
   typed try/catch, never logging the token. Pacing from SEND_RATE_PER_HOUR (default ~60) and a
   withinSendWindow() helper (default 10am-7pm CT per sms-copy.md).

3. app/api/campaign/route.ts — POST runs/resumes the paced send over eligible contacts: assign an
   A/B variant (A/B/C from sms-copy.md; record it in a new contacts.variant column), render via
   renderMessage, assert withinSingleSegment (skip+log overflows, never send 2 segments), sendOne,
   recordMessage(outbound), set send_status. Idempotent/resumable: only select send_status='not_sent'
   and mark state immediately so a re-run never double-texts. Support { dryRun } (report eligible
   count + per-variant split, no send) and require { confirm:true } + a passing send-window check for
   any real send. GET returns progress JSON (eligible, sent, pending, failed, suppressed, opted_out).

4. scripts/smoke-twilio.ts (+ npm run smoke:twilio) — send ONE message to SMOKE_TO_NUMBER using
   renderMessage; print the Twilio SID + status. This is the acceptance gate.

Compliance is non-negotiable: the eligibility query is the only gate on who can be texted; never
select suppressed, opted-out, already-sent, or non-'clean' scrub_status contacts; treat any
uncertainty as ineligible.

If anything is ambiguous or out of Module 3 scope, STOP and ask before coding.

When complete:
- Run `npm run smoke:twilio`, confirm you received the message, and paste me the SID/status output.
- Update status.md (Session 3 -> Completed, deviations), rewrite handoff.md for Session 4, set
  Module 3 -> Done in modules.md, and record the A/B + pacing/send-window decisions in overview.md.
- Then tell me to run the parallel review pass (sessions/session-3-review.md).
```

---

## After Session 3
Run `sessions/session-3-review.md` (agent-team compliance/security/correctness review of the send
path). Then back to Cowork for Session 4 (inbound webhook: STOP + triage + forward), which consumes
`lib/classify.ts` and is the other half of the compliance core.
