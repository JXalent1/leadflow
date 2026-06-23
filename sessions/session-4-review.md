# Session 4 — parallel compliance/security review (agent team)

Run **after** Session 4's build passes, in a Claude Code session with agent teams enabled
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). STOP handling is load-bearing compliance, so the inbound
path gets the same three-lens scrutiny the send path got.

## What's under review
`app/api/webhook/twilio/route.ts`, `lib/forward.ts`, the new `lib/db.ts` helpers
(`findContactByPhone`, `recordOptOut`, `markLeadForwarded`), and `lib/classify.ts` as consumed.

## Team structure
Lead + 3 Sonnet teammates, **read-only reviewers** (they report; only the lead applies fixes —
Critical/High — then re-verifies). Only the lead writes files.

| Reviewer | Lens — looks for |
|----------|------------------|
| **security** | Is `X-Twilio-Signature` validated against the exact posted URL with the auth token, and rejected (403) BEFORE any DB write/ping? Can a forged request create a lead/opt-out or trigger an SMS ping? Is the ping target locked to `TALAN_FORWARD_PHONE` from env (never from request data)? Token never logged; no PII/error leakage; injection. |
| **compliance** | Is STOP honored instantly and permanently (suppress + single confirmation), with **absolute precedence** over classification (a "yes but STOP" text must opt out, not forward)? Is the full CTIA keyword set caught (via `isOptOut`)? Is exactly ONE confirmation sent (no double via TwiML + API)? Is an opt-out/non-interested reply never forwarded? Does suppression actually block future sends (cross-check the eligibility query)? |
| **correctness** | Idempotency on Twilio retries (same `MessageSid` processed once — no duplicate opt-out/lead/forward/log); phone normalization + matching (and orphan inbound handled without crashing); lead-forward failure path (not silently dropped; `forwarded` stays false for retry); every inbound logged; TwiML response valid. |

Have the reviewers challenge each other on the two guarantees: **STOP is always honored** and **a
forged request can do nothing**.

## Lead's job
1. Spawn the three reviewers with the lenses above + the file list.
2. Collect findings into ONE prioritized list (Critical / High / Medium / Low) with a concrete fix.
3. Apply Critical + High fixes; re-run `npm run build` and the tests. Verify a forged request → 403
   and a STOP → suppress + single confirmation + no duplicate on retry.
4. **Critical by definition:** any path where a forged/unsigned request causes a side effect, or
   where a STOP fails to suppress or gets forwarded as a lead. Fix before the review is done.
5. Update `status.md` (review complete + fixes) and record any decision in `overview.md`.

## The prompt (copy everything in the block below into Claude Code)

```
Agent-team review pass on the finished Module 4 inbound webhook + forward path. Confirm team tools
are available; if not, tell me to set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and restart.

Read CLAUDE.md and sessions/session-4.md first. Then spawn 3 read-only reviewer teammates on Sonnet
(they report findings, they do NOT edit — only I apply fixes). Each reviews
app/api/webhook/twilio/route.ts, lib/forward.ts, the new lib/db.ts helpers, and lib/classify.ts as
consumed:

- Teammate "security": is X-Twilio-Signature validated (auth token + exact posted URL + params) and
  rejected 403 BEFORE any DB write or forward? Can a forged request create a lead/opt-out or trigger
  an SMS ping? Is the ping target taken ONLY from env (TALAN_FORWARD_PHONE), never from
  request data? Token never logged; no PII/error leakage; injection.

- Teammate "compliance": is STOP instant + permanent (suppress + exactly one confirmation) with
  ABSOLUTE precedence over classification (a "yes, but stop" must opt out, not forward)? Full CTIA
  set caught via isOptOut? Exactly one confirmation (no TwiML + API double)? Opt-out/non-interested
  never forwarded? Does suppression actually block future sends (cross-check getEligibleContacts)?

- Teammate "correctness": idempotency on Twilio retries (same MessageSid once — no duplicate
  opt-out/lead/forward/log), phone normalization + matching, orphan-inbound handled without crash,
  lead-forward failure not silently dropped (forwarded stays false), every inbound logged, valid
  TwiML.

Have the teammates challenge each other on "STOP is always honored" and "a forged request can do
nothing."

As lead: collect findings into ONE prioritized list (Critical/High/Medium/Low) with a concrete fix
each. Any forged-request side effect, or any STOP that fails to suppress / gets forwarded, is
Critical. Apply Critical + High fixes yourself, then re-run npm run build + the tests and verify a
forged request -> 403 and a STOP -> suppress + single confirmation + no duplicate on retry. Leave
Medium/Low as logged recommendations.

When done: paste me the prioritized findings list and what you fixed; update status.md (review
complete) and record any decision in overview.md.
```
