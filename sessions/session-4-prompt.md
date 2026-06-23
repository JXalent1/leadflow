# Session 4 — kick-start prompt

Paste into **Claude Code** (project root) to build Module 4. Full spec: `sessions/session-4.md`.
Single focused **spine** session. After it passes, run the review pass: `sessions/session-4-review.md`.

---

## Before you paste this

1. **Env in `.env.local`** (gitignored):
   ```
   TALAN_FORWARD_PHONE=+1XXXXXXXXXX     # where the SMS lead ping goes (use your own phone to test)
   ```
   `TWILIO_AUTH_TOKEN` (already set) is required — it validates inbound webhook signatures.
   No email/Resend — leads also surface on the dashboard (Module 5).
2. **No live webhook needed to build.** The Twilio inbound (Messaging) webhook → `/api/webhook/twilio`
   gets configured in Session 6 (deployed URL) or via a tunnel for local testing. Building +
   unit-testing the handler here doesn't need it.
3. If you don't have Talan's number yet, use your own as `TALAN_FORWARD_PHONE` to test the forward.

---

## The prompt (copy everything in the block below)

```
Read `CLAUDE.md`, `handoff.md`, and `sessions/session-4.md` in full before writing any code.

Your scope is ONLY Module 4: the inbound webhook (STOP + interest triage + lead forwarding). Do NOT:
- Build any AI back-and-forth conversation.
- Build dashboard UI (Session 5).
- Change the outbound campaign code (Session 3 is done).
- Re-implement opt-out or interest logic — IMPORT isOptOut / classifyInterest from lib/classify.ts.
- Re-implement SMS sending — IMPORT sendOne from lib/twilio.ts.
- Create any file over 500 lines.

Build:
- app/api/webhook/twilio/route.ts (POST). FIRST validate the X-Twilio-Signature header with
  Twilio's request validation (twilio.validateRequest with TWILIO_AUTH_TOKEN, the signature, the
  exact posted URL, and params) — reject invalid/missing signatures with 403 BEFORE any DB write or
  forward. This is the webhook's only auth; it's a Critical requirement.
  Then process in this order:
  1. Idempotency: if messages.twilio_sid already has this MessageSid, stop (Twilio retries) — log
     inbound with the SID so the dedupe key exists.
  2. Match sender via findContactByPhone(normalizePhone(From)); log every inbound to messages
     (direction='inbound'), matched or not (orphan = no crash).
  3. STOP FIRST, unconditionally: if isOptOut(Body) -> recordOptOut + markSuppressed(id,'opt_out')
     + send exactly ONE CTIA confirmation -> DONE. Never classify or forward a STOP, even if it also
     contains interest words.
  4. Else classifyInterest(Body): 'interested' -> createLead + forwardLead + markLeadForwarded;
     'not_interested'/'neutral' -> log only (no lead, no forward, no suppression).
  5. Return TwiML; send the STOP confirmation exactly once (TwiML <Message> OR an API send, not both).
- lib/forward.ts: forwardLead({contact, replyText}) -> the lead row is already created (shows on the
  dashboard), then send a terse one-line SMS ping to TALAN_FORWARD_PHONE with name + address + reply
  text. SMS only — NO email, NO Resend. On success mark forwarded=true/forwarded_at; on failure log
  and leave forwarded=false (the lead is still on the dashboard, so a failed ping never loses it).
  Typed try/catch; never log the auth token.
- Additive lib/db.ts helpers: findContactByPhone, recordOptOut, markLeadForwarded (don't rename
  existing ones).

Compliance (non-negotiable): signature validation gates everything; STOP is instant + permanent and
takes absolute precedence over classification; never forward an opt-out/non-interested reply; same
MessageSid is processed once.

Add unit/fixture tests for STOP precedence, idempotency (duplicate MessageSid), and classification
routing. If anything is ambiguous or out of Module 4 scope, STOP and ask before coding.

When complete:
- Paste me the test results + a short description of how you simulated an inbound (and a forged
  request returning 403).
- Update status.md (Session 4 -> Completed, deviations), rewrite handoff.md for Session 5, set
  Module 4 -> Done in modules.md, and record decisions (signature validation, forward channels) in
  overview.md.
- Then tell me to run sessions/session-4-review.md.
```

---

## After Session 4
Run `sessions/session-4-review.md` (agent-team review of the webhook + forward path). Then back to
Cowork for Session 5 (Dashboard UI) — which just surfaces the data and triggers the endpoints built
in 2–4, no new backend logic.
