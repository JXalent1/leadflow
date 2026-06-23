# Session 4 — Inbound webhook: STOP + triage + forward

## Objective
Handle inbound SMS: honor opt-outs **instantly and permanently**, classify interest, and forward
hot leads to Talan. This is Module 4 — the second half of the compliance core (STOP handling), so
like the send path it gets a parallel review pass after the build. It consumes `lib/classify.ts`
(`isOptOut`, `classifyInterest`) from Module P — do not rebuild that logic.

## Prerequisites
- `CLAUDE.md`, `handoff.md`, `sessions/session-4.md` read in full.
- Modules 1, 2, 3, and P complete. `lib/classify.ts`, `lib/db.ts`, `lib/twilio.ts` exist.
- Env: Twilio creds (exist). Add `TALAN_FORWARD_PHONE` (where the SMS lead ping goes).
- `TWILIO_AUTH_TOKEN` is present (required for inbound signature validation).

## Lead delivery — DECIDED
Talan gets leads **two ways: the dashboard (Module 5) + an instant one-line SMS ping** when an
interested reply comes in. **No email / no Resend.** Every interested reply is written to the
`leads` table (the dashboard's source) AND texted to `TALAN_FORWARD_PHONE`. For testing the ping,
use your own phone as `TALAN_FORWARD_PHONE`.

## Webhook URL (configured later, in Session 6)
The Twilio inbound (Messaging) webhook points at `POST /api/webhook/twilio`. That URL only exists
once deployed (Vercel) or tunneled (e.g., `ngrok`/`cloudflared`) for local testing. **Configuring
it in the Twilio console is a Session 6 / local-test step** — building and unit-testing the handler
here does not require it.

## Scope for this session
Build:
- `app/api/webhook/twilio/route.ts` — POST: receive inbound SMS, validate signature, route to STOP /
  triage / forward, log everything, return TwiML.
- `lib/forward.ts` — create a lead (DB row for the dashboard) + send a one-line SMS ping to Talan
  via `lib/twilio.ts`. SMS only; no email/Resend.
- Additive `lib/db.ts` helpers as needed: `findContactByPhone(phone)`, `recordOptOut(contactId, phone)`,
  `markLeadForwarded(leadId)`. Keep existing signatures.

Do NOT build:
- Any AI back-and-forth conversation (later module).
- Dashboard UI (Session 5).
- Outbound campaign changes (Session 3 is done).

## Detailed specification

### Security — Twilio signature validation (the webhook's "auth")
This endpoint is public (Twilio calls it), so it has no admin gate — **its auth is the
`X-Twilio-Signature` header.** Validate every request with Twilio's request validation
(`twilio.validateRequest(authToken, signature, url, params)`), using the exact public URL Twilio
posted to. Reject invalid signatures with 403 **before** any DB write or forward. Without this,
anyone could forge an "interested" reply (spamming Talan) or a fake STOP. This is Critical — treat
a missing/invalid signature as a hard reject.

### Inbound processing order (STOP has absolute precedence)
1. Validate signature (above). Parse `From`, `Body`, `MessageSid`.
2. **Idempotency:** if a message with this `MessageSid` is already logged (`messages.twilio_sid`),
   stop — Twilio retries webhooks, and we must not double-process (double opt-out, double lead,
   double forward). Log inbound with the SID so the dedupe key exists.
3. Match the sender: `findContactByPhone(normalizePhone(From))`. Log the inbound to `messages`
   (`direction='inbound'`, body, twilio_sid) even if no contact matches (orphan inbound).
4. **STOP first, unconditionally:** if `isOptOut(Body)` → `recordOptOut(contactId, phone)` +
   `markSuppressed(contactId, 'opt_out')` + send the single CTIA-required confirmation
   ("You're unsubscribed and won't receive more messages…") → DONE. Never classify or forward a
   STOP. STOP wins even if the text also contains interest words.
5. Otherwise `classifyInterest(Body)`:
   - `interested` → `createLead` + `lib/forward.ts` (forward to Talan) + `markLeadForwarded`.
   - `not_interested` / `neutral` → log only; no lead, no forward, no suppression.
6. Return TwiML (`<Response/>`, or a `<Message>` only for the STOP confirmation if you choose TwiML
   over an API send — send the confirmation exactly once, not both ways).

### `lib/forward.ts`
- `forwardLead({ contact, replyText })`:
  - The lead row is already created (`createLead`) so it shows on the dashboard regardless.
  - SMS ping: `sendOne(TALAN_FORWARD_PHONE, body)` where body is a terse one-liner with the
    homeowner's name, address, and the reply text. Wrap in typed try/catch.
  - On success mark the lead forwarded (`forwarded=true`, `forwarded_at=now`). On failure, log it and
    leave `forwarded=false` — the lead is still on the dashboard, so a failed ping never loses the
    lead; the dashboard's `forwarded` flag surfaces which pings didn't go through.
  - No email, no Resend.
- Do NOT ping/forward opt-outs or non-interested replies.

### Logging
Every inbound message is written to `messages` (`direction='inbound'`), matched or not. Outbound
confirmations/forwards are logged too (reuse `recordMessage`).

## Compliance (hard requirements)
- STOP is instant and permanent: suppress immediately, send exactly one confirmation, never message
  that contact again (the send path's eligibility already excludes `suppressed=true`).
- Never forward a STOP/opt-out as a lead. STOP precedence over classification is absolute.
- Signature validation gates everything — no DB writes/forwards on an unverified request.
- Idempotent on Twilio retries — same `MessageSid` processed once.

## Constraints
- No file exceeds 500 lines. Secrets via env only; never log the auth token.
- Import `isOptOut` / `classifyInterest` from `lib/classify.ts`; `sendOne` from `lib/twilio.ts`. No
  re-implementation.
- Stay in scope: no AI conversation, no dashboard, no outbound changes.

## Acceptance
- A forged request (bad/missing signature) → 403, no side effects.
- A STOP reply (from a known contact) → opt_outs row, `suppressed=true`/`suppress_reason='opt_out'`,
  exactly one confirmation sent, logged. A repeat STOP (same SID) → no duplicate.
- An interested reply → lead created (shows on dashboard), one SMS ping sent to Talan,
  `forwarded=true`/`forwarded_at` set, logged. A failed ping leaves the lead intact with
  `forwarded=false`.
- A neutral/not-interested reply → logged only; no lead/forward/suppression.
- An unknown-sender inbound → logged as orphan; no crash.
- `npm run build` passes; unit/fixture tests cover STOP precedence, idempotency, and classification
  routing.
- `status.md`, `handoff.md` (→ Session 5), `modules.md` (Module 4 → Done) updated; record decisions
  (signature-validation approach, forward channels) in `overview.md`.

## After the build → parallel compliance review
Run `sessions/session-4-review.md` (agent-team: security / compliance / correctness) on the finished
webhook + forward path before it goes live.

## Open questions
- TwiML `<Message>` vs API send for the STOP confirmation — pick one, send exactly once. Note that if
  a Twilio Messaging Service with Advanced Opt-Out is ever enabled, Twilio auto-handles STOP and you
  must NOT also send a confirmation (avoid double). For a plain from-number, we own STOP here.
- Ping message format Talan wants (what fields, how terse) — default to name + address + reply;
  refine after Talan sees one.
