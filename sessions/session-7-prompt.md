# Session 7 — kick-start prompt (inbox + reply + lead tracking)

Paste into **Claude Code** (project root) to build Module 7. Full spec: `sessions/session-7.md`.
Single focused **build** session; after it passes, run `sessions/session-7-review.md` (agent-team
review of the reply send path).

---

## Before you paste this
- Nothing new in `.env.local`. (`TALAN_FORWARD_PHONE`, Twilio creds already set.)
- The reply box texts real homeowners' phones — but for this build/test you reply only to contacts in
  the DB, and there won't be real inbound threads until the pilot. Test the suppression refusal with a
  fixture (a suppressed contact) rather than texting anyone.

---

## The prompt (copy everything in the block below)

```
Read `CLAUDE.md`, `handoff.md`, and `sessions/session-7.md` in full before writing any code.

Scope: ONLY Module 7 — dashboard inbox, a manual reply box, and lead status/notes tracking. Do NOT:
- Build AI / automated replies (this is a manual reply box — human handoff stays).
- Build bulk/blast replies or any new cold-send path.
- Change the campaign blast, the inbound webhook, or the trace/scrub logic.
- Re-implement sending or auth — reuse sendOne (lib/twilio), recordMessage, and the isAuthed gate.
- Create any file over 500 lines.

Build:
1. Schema (db/schema.sql, idempotent ALTER ... ADD COLUMN IF NOT EXISTS): leads.status text not null
   default 'new' (new|contacted|quoted|scheduled|won|lost) + leads.notes text. Apply via npm run schema.

2. lib/db.ts additive helpers (don't rename existing): getInboxThreads(limit?) (one row per contact
   with any inbound or a lead: name, phone, address, last message + direction + time, needs_reply =
   last message is inbound, the contact's suppressed flag, lead status), getThread(contactId) (contact
   + lead status/notes + all messages chronological), getContactById(id), setLeadStatus(leadId,
   {status?, notes?}).

3. app/api/reply/route.ts (POST) — THE COMPLIANCE-CRITICAL PART. Admin-gated (isAuthed; 401 if not).
   Body { contactId, body }. Load the contact and send ONLY to contact.phone — NEVER accept a
   destination phone from the request. If the contact is suppressed / has an opt_outs row (or has no
   phone / not found) => REFUSE with 4xx (recipient_suppressed). On pass: sendOne(contact.phone, body)
   -> recordMessage({contactId, direction:'outbound', body, twilioSid, status}); return the result.
   try/catch, never log the token. Do NOT hard-block on the campaign send window (a 1:1 reply is
   conversational); suppression is the gate. Manual replies may be multi-segment — that's fine.

4. app/api/leads/route.ts (POST) — admin-gated. { leadId, status?, notes? } -> setLeadStatus
   (validate status against the allowed set). Returns the updated lead.

5. app/inbox/page.tsx (admin-gated; unauthed -> redirect to /) + components/inbox/*: a conversation
   list (name, last-message preview, time, a clear "needs reply" badge; suppressed contacts marked and
   their reply box disabled), a thread view (full history, inbound vs outbound distinct) with a reply
   box at the bottom (posts to /api/reply, then refreshes), and a lead status dropdown + notes field
   (posts to /api/leads). Link to /inbox from the dashboard, and show lead status on the dashboard
   leads table.

Compliance (non-negotiable): the reply endpoint refuses to text any suppressed/opted-out contact and
only ever sends to the stored contact phone; the UI disables the reply box for suppressed contacts;
every outbound reply is logged to messages; every new endpoint is admin-gated.

Test the suppression refusal with a fixture (suppressed contact => reply 4xx, box disabled) — do NOT
text a real person to verify. If anything is ambiguous or out of Module 7 scope, STOP and ask.

When complete:
- Show me: build passes, the suppression-refusal proof, and how the inbox/thread/reply/status look.
- Update status.md (Session 7 -> Completed, deviations), rewrite handoff.md (next = deploy + pilot),
  set Module 7 -> Done in modules.md, record decisions in overview.md.
- Then tell me to run sessions/session-7-review.md.
```

---

## After Session 7
Run `sessions/session-7-review.md` (agent-team review of the reply send path). Then it's back to
Session 6 — deploy everything (now including the inbox) + the self-test + the live pilot run.
