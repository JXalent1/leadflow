# End-to-end test of the reply loop + deploy current code to Vercel

## Why
The inbox reply flow has never been verified live (every manual test so far came from a number
that isn't a contact → orphan, which correctly doesn't thread). And the production Vercel deploy
predates recent changes. Before launching: (1) deploy the current reviewed code, and (2) prove the
full inbound → inbox → reply → STOP loop with an automated test, not by hand.

Context: prod URL is https://leadflow1-seven.vercel.app. Vercel CLI is already `vercel link`ed to the
`leadflow1` project. GitHub auto-deploy is broken, so deploy via the CLI. A self-test contact (id 516,
first_name "Jordan", a real phone, send_status='sent' so it's NOT in the 91-eligible pool) exists for
the manual round-trip.

## Paste into Claude Code

```
Read CLAUDE.md and sessions/e2e-test-and-deploy.md first.

PART 1 — automated end-to-end test of the reply loop (no real phone needed):
Write scripts/e2e-reply-loop.ts that exercises the FULL inbound→inbox→reply→STOP path against the
real lib functions + a temporary test contact, with Twilio sendOne mocked/stubbed (no real SMS, no
credits). It must assert, in order:
  1. Insert a temp test contact (unique phone, scrub_status='clean', not suppressed).
  2. Simulate an inbound "interested" via the SAME processInbound path the webhook uses (matched by
     phone): assert the inbound is logged WITH contact_id set (not null), a lead row is created, and
     getInboxThreads() returns that contact with needs_reply=true.
  3. Reply: call the /api/reply logic (the lib path it uses) with a body for that contact: assert
     sendOne is called with the CONTACT'S phone (never a request-supplied number), the outbound is
     logged, and getThread(contactId) shows inbound THEN outbound in order.
  4. Simulate an inbound "STOP" via processInbound: assert the contact becomes suppressed + an
     opt_outs row exists + exactly one confirmation, and getEligibleContacts() excludes it, and a
     subsequent /api/reply to that contact is REFUSED (recipient_suppressed).
  5. Delete the temp contact + its messages/leads/opt_outs so the DB is left clean (500 contacts,
     91 eligible, no test rows).
Print PASS/FAIL per step. This proves the loop end-to-end in code. If any step fails, that's the real
bug — fix it (in scope: webhook/inbound/inbox/reply only) and re-run.

PART 2 — also verify the live webhook signature path:
Confirm app/api/webhook/twilio validates a correctly-signed request and 403s an unsigned one
(reuse/extend npm run smoke:webhook). Confirm app/api/reply is admin-gated.

PART 3 — deploy the current code to Vercel:
Run `vercel --prod` (project is linked). Confirm the build is green and the deployment URL serves
/dashboard and /inbox. Report the deployment URL + commit. (Use the CLI — GitHub auto-deploy is off.)

REPORT: the e2e PASS/FAIL per step, the deployment URL, and a one-line "the reply loop works
end-to-end: yes/no". Update status.md + handoff.md. Do NOT send any real SMS or spend credits.
```

## After it passes
Manual live confirmation (with the deployed code + self-test contact 516):
1. From your phone, text (850) 821-3720 fresh ("interested") → it should now appear as a
   **conversation** in /inbox (it matches contact 516).
2. Open it, type a reply, send → your phone gets the reply from the campaign number.
3. Text STOP → you get the confirmation, dashboard OPTED OUT → 1, the reply box disables.
Then remove the self-test contact (516) and launch the 91.
```
