# Session 7 — parallel review (agent team): the reply send path

Run **after** Session 7's build passes, with agent teams enabled
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Module 7 adds a way to text homeowners back, so the
reply path gets the same three-lens scrutiny as the campaign send and the STOP handling — the one
guarantee that matters most: **you can never reply to someone who opted out.**

## What's under review
`app/api/reply/route.ts`, `app/api/leads/route.ts`, the new `lib/db.ts` helpers
(`getInboxThreads`, `getThread`, `getContactById`, `setLeadStatus`), and the inbox UI
(`app/inbox/page.tsx`, `components/inbox/*`) — focused on the reply send.

## Team structure
Lead + 3 Sonnet teammates, **read-only reviewers** (report only; the lead applies Critical/High fixes
and re-verifies; only the lead writes files).

| Reviewer | Lens — looks for |
|----------|------------------|
| **security** | Is `/api/reply` (and `/api/leads`) admin-gated (`isAuthed`), 401 otherwise? Does reply send ONLY to the stored `contact.phone` and never a phone/number taken from the request body? Token never logged; no PII/error leakage; input validation; no SSRF/injection. |
| **compliance** | Can ANY path send a reply to a `suppressed` / opted-out contact? Is the suppression check done BEFORE `sendOne`, and does the UI also disable the box for suppressed contacts (defense in depth)? Is a missing-phone / unknown-contact treated as a refusal? Is every outbound reply logged to `messages`? Cross-check that a replied-to contact who later sends STOP is still suppressed everywhere. |
| **correctness** | Thread assembly correct (right contact, chronological, inbound vs outbound)? `needs_reply` accurate? Status updates validated against the allowed set and reflected on the dashboard? No double-send on a double-click? Failure path surfaced (a failed `sendOne` doesn't look like success)? |

Have the reviewers challenge each other on: **"a reply can never reach an opted-out person"** and
**"the reply endpoint can't be used to text an arbitrary number."**

## Lead's job
1. Spawn the three reviewers with the lenses + file list.
2. Collect findings into ONE prioritized list (Critical / High / Medium / Low) with a concrete fix.
3. Apply Critical + High; re-run `npm run build` + tests; verify the suppression refusal (suppressed
   contact → reply 4xx + box disabled) and that replies only go to the stored phone.
4. **Critical by definition:** any path that texts a suppressed/opted-out contact, or that sends to a
   request-supplied number. Fix before the review is done.
5. Update `status.md` (review complete + fixes) and record any decision in `overview.md`.

## The prompt (copy everything in the block below into Claude Code)

```
Agent-team review pass on the finished Module 7 reply/inbox path. Confirm team tools are available;
if not, tell me to set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and restart.

Read CLAUDE.md and sessions/session-7.md first. Then spawn 3 read-only reviewer teammates on Sonnet
(report only; I apply fixes). Each reviews app/api/reply/route.ts, app/api/leads/route.ts, the new
lib/db.ts helpers, and the inbox UI (app/inbox/*, components/inbox/*):

- Teammate "security": is /api/reply and /api/leads admin-gated (isAuthed, 401 otherwise)? Does reply
  send ONLY to the stored contact.phone, never a number from the request body? Token never logged,
  input validated, no injection/PII leakage.

- Teammate "compliance": can ANY path reply to a suppressed/opted-out contact? Is the suppression
  check BEFORE sendOne, with the UI also disabling the box (defense in depth)? Missing-phone/unknown
  contact => refusal? Every outbound reply logged to messages? A replied-to contact who then sends
  STOP still suppressed everywhere?

- Teammate "correctness": thread assembly (right contact, chronological, inbound vs outbound),
  needs_reply accuracy, status validated + reflected on the dashboard, no double-send on double-click,
  failed sendOne not shown as success.

Have them challenge each other on "a reply can never reach an opted-out person" and "the endpoint
can't text an arbitrary number."

As lead: one prioritized findings list (Critical/High/Medium/Low) + concrete fixes. Any reply to a
suppressed contact, or send to a request-supplied number, is Critical. Apply Critical + High, re-run
npm run build + tests, and verify the suppression refusal + stored-phone-only behavior. Leave
Medium/Low as logged recommendations.

When done: paste me the findings list and what you fixed; update status.md and record decisions in
overview.md.
```
