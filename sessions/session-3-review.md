# Session 3 — parallel compliance/security review (agent team)

Run this **after** Session 3's build passes its smoke gate, in a Claude Code session with agent
teams enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). This is the review pass we reserved for
the load-bearing compliance code: three reviewers, three independent lenses, on the finished send
path — *before* it ever touches the real list.

Why a team here: a single reviewer tends to fixate on one class of issue. Splitting security,
compliance, and correctness across independent teammates (who then challenge each other) gives the
suppression/send path the scrutiny it actually needs.

## What's under review
The finished Module 3 code and its eligibility gate:
`lib/twilio.ts`, `app/api/campaign/route.ts`, `app/api/scrub/route.ts` (the `scrub_status` write),
`getEligibleContacts()` in `lib/db.ts`, and `lib/sms.ts` as consumed by the send path.

## Team structure
Lead + 3 Sonnet teammates. Teammates are **read-only reviewers** — they investigate and report
findings; they do NOT edit code. The lead synthesizes, then applies only Critical/High fixes and
re-verifies. Only the lead writes files (no edit conflicts).

| Reviewer | Lens — looks for |
|----------|------------------|
| **security** | Auth on `/api/campaign` (an open POST that sends SMS is a serious hole — must be admin-gated); token/secret never logged or returned; SQL safety; error/PII leakage in responses; abuse/rate-limit; env handling. |
| **compliance** | The TCPA core: can ANY code path text a contact that is `suppressed`, opted-out, `scrub_status != 'clean'`, or already-sent? Is the eligibility query airtight and the single gate? Does `{confirm:true}` + send-window actually prevent an accidental 500-send? Opt-out line present in EVERY rendered variant? Single-segment enforced (never a silent 2-segment send)? |
| **correctness** | Idempotency/resumability under crash + retry (no double-text); pacing actually enforced; send-window timezone/DST correctness (CT); A/B split correct and recorded per contact; `send_status` transitions; failure paths; `campaign_runs` accounting; off-by-one. |

Have the reviewers message each other to challenge findings (e.g., compliance + correctness jointly
stress-test the "never double-text" guarantee). 

## Lead's job
1. Spawn the three reviewers with the lenses above; give each the file list.
2. Collect findings; produce ONE prioritized list with severity (Critical / High / Medium / Low)
   and a concrete fix for each.
3. **Apply the Critical and High fixes yourself**, then re-run `npm run build` and
   `npm run smoke:twilio` to confirm nothing regressed. Leave Medium/Low as logged recommendations.
4. A finding that the send path can reach a suppressed/unscrubbed/opted-out/already-sent contact is
   **Critical by definition** — fix before this review is considered done.
5. Update `status.md` (review pass complete + what was fixed) and note any resulting decision in
   `overview.md`.

## The prompt (copy everything in the block below into Claude Code)

```
Agent-team review pass on the finished Module 3 send path. Confirm team tools are available; if not,
tell me to set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and restart.

Read CLAUDE.md and sessions/session-3.md first. Then spawn 3 read-only reviewer teammates on Sonnet
(they report findings, they do NOT edit code — only I apply fixes). Each reviews lib/twilio.ts,
app/api/campaign/route.ts, app/api/scrub/route.ts, getEligibleContacts() in lib/db.ts, and lib/sms.ts
as consumed:

- Teammate "security": is /api/campaign admin-gated (an unauthenticated SMS-send endpoint is a
  Critical hole)? Is the Twilio token never logged or returned? SQL safety, PII/error leakage in
  responses, abuse/rate-limit, env handling.

- Teammate "compliance": can ANY path text a contact that is suppressed, opted-out,
  scrub_status != 'clean', or already-sent? Is getEligibleContacts the single airtight gate? Does
  {confirm:true} + the send-window check actually prevent an accidental full send? Is the opt-out
  line in every rendered variant and is single-segment enforced (no silent 2-segment sends)?

- Teammate "correctness": idempotency/resumability under crash+retry (no double-text), pacing
  actually enforced, send-window timezone/DST correctness for CT, A/B split correct and recorded,
  send_status transitions, failure handling, campaign_runs accounting.

Have the teammates message each other to challenge each other's findings, especially on the
"never double-text" and "never text an ineligible contact" guarantees.

As lead: collect findings into ONE prioritized list (Critical/High/Medium/Low) with a concrete fix
for each. Any path that can reach a suppressed/unscrubbed/opted-out/already-sent contact is Critical.
Apply the Critical and High fixes yourself, then re-run `npm run build` and `npm run smoke:twilio`
to confirm no regression. Leave Medium/Low as logged recommendations.

When done: paste me the prioritized findings list and what you fixed; update status.md (review pass
complete) and record any decision in overview.md.
```
