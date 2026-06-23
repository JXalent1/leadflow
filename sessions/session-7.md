# Session 7 — Inbox + reply + lead tracking

## Objective
Turn the read-only dashboard into a workspace for leads: see each homeowner's full conversation,
**reply to them from the campaign number** inside the app, and track each lead's status. This adds a
new outbound-send path (replying to a person who texted in), so suppression discipline is the
load-bearing requirement — and it gets an agent-team review after the build.

## Prerequisites
- `CLAUDE.md`, `handoff.md`, `sessions/session-7.md` read in full.
- Modules 1–5 complete; Session 6 Task 0 done (approved copy locked). The inbound webhook already
  logs every inbound to `messages` and creates `leads` rows.
- Reuse: `sendOne` (`lib/twilio.ts`), `recordMessage` / the `messages` table, the admin gate
  (`isAuthed`).

## Scope for this session
Build three things:
1. **Inbox / conversation view** (read) — list of conversations + full per-contact thread.
2. **Reply box** (new outbound send) — text a homeowner back from the campaign number.
3. **Lead status + notes** (tracking) — move a lead through a simple funnel.

Do NOT build:
- AI / automated replies (still human handoff — this is a manual reply box).
- Bulk/blast replies, or any new cold-send path.
- Changes to the campaign blast, the webhook, or the scrub/trace logic.

## Detailed specification

### Schema (`db/schema.sql`, idempotent)
- `leads.status text NOT NULL DEFAULT 'new'` — values: `new | contacted | quoted | scheduled | won | lost`.
- `leads.notes text` — free-text operator notes.
- Add via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; apply with `npm run schema`. No other tables
  change — conversation threads come from the existing `messages` rows.

### DB helpers (`lib/db.ts`, additive — don't rename existing)
- `getInboxThreads(limit?)` — one row per contact that has any inbound message OR a lead: contact id,
  name, phone, address, last message (body + direction + time), a **needs_reply** flag (true when the
  most recent message is inbound), the contact's **suppressed** flag, and the lead status if any.
  Ordered by last activity, newest first.
- `getThread(contactId)` — the contact (name, phone, address, suppressed, lead id + status + notes)
  plus all `messages` for that contact in chronological order (inbound + outbound).
- `getContactById(id)` — needed by the reply endpoint to read phone + suppression.
- `setLeadStatus(leadId, { status?, notes? })` — update one lead.
- Reuse `recordMessage(...)` for logging the outbound reply.

### Reply endpoint — `app/api/reply/route.ts` (POST) — the compliance-critical part
- **Admin-gated** (`isAuthed`) — same as the other control endpoints. 401 if not authed.
- Body: `{ contactId: number, body: string }`. **NEVER accept a destination phone from the request** —
  load the contact and send ONLY to `contact.phone`. (Prevents the tool from texting arbitrary numbers.)
- **Suppression gate (hard):** if the contact is `suppressed` / has an `opt_outs` row → **refuse with
  4xx** (`recipient_suppressed`). You may not text someone who opted out, even as a "reply." Treat a
  missing contact/phone as a refusal too.
- On pass: `sendOne(contact.phone, body)`; on success `recordMessage({ contactId, direction:'outbound',
  body, twilioSid, status })`; return the result. Wrap in try/catch; never log the auth token.
- **Send window:** do NOT hard-block replies on the campaign send window — a manual 1:1 reply to
  someone who just messaged you is conversational and time-sensitive. (Suppression is the gate that
  matters.) A soft "outside normal hours" hint in the UI is fine.
- Manual replies may exceed one segment (a human is typing) — that's acceptable; show the segment
  count in the UI but don't block. The campaign blast's single-segment rule does NOT apply here.

### Lead update endpoint — `app/api/leads/route.ts` (POST)
- Admin-gated. Body `{ leadId, status?, notes? }` → `setLeadStatus`. Validate `status` against the
  allowed set. Returns the updated lead.

### Inbox UI — `app/inbox/page.tsx` (admin-gated) + `components/inbox/*`
- Behind the admin gate (unauthed → redirect to `/`). Link to it from the dashboard.
- **Conversation list** (left/top): each thread with name, last-message preview, time, and a clear
  **"needs reply"** badge; suppressed contacts visibly marked (and their reply box disabled).
- **Thread view** (right/main): the full message history for the selected contact (inbound vs
  outbound visually distinct), with a **reply box** at the bottom. Sending posts to `/api/reply`,
  then refreshes the thread. If the contact is suppressed, the reply box is disabled with a note
  ("opted out — can't message").
- **Lead status control:** a dropdown (new/contacted/quoted/scheduled/won/lost) + a notes field that
  POST to `/api/leads`. Reflect changes on the dashboard leads table too.
- Minimal Tailwind, functional. Keep each component < 500 lines (split as needed).

### Dashboard wiring
- The dashboard leads table should show the lead `status` and link each lead to its inbox thread.

## Compliance (hard requirements)
- **Never reply to a suppressed / opted-out contact** — the reply endpoint refuses, the UI disables
  the box. This is the same "honor STOP" guarantee on the manual path.
- Replies go only to the contact's stored phone, never a request-supplied number.
- Every outbound reply is logged to `messages`. Admin-gate every new endpoint.

## Constraints
- No file > 500 lines. Secrets via env only; never log the token. Reuse `sendOne`/`recordMessage`/
  `isAuthed` — do not re-implement sending or auth. Stay in scope.

## Acceptance
- Schema adds `leads.status` + `leads.notes`; `npm run schema` applies cleanly.
- Inbox lists conversations with a needs-reply badge; opening one shows the full thread.
- Replying sends from the campaign number, logs the outbound, and appears in the thread.
- Replying to a suppressed/opted-out contact is **refused** (endpoint 4xx + UI disabled) — prove it.
- Lead status/notes update and show on both the inbox and the dashboard leads table.
- `npm run build` + tests pass.
- `status.md`, `handoff.md` (→ deploy/pilot), `modules.md` (Module 7 → Done) updated; decisions in
  `overview.md`.

## After the build → parallel review
Run `sessions/session-7-review.md` (agent-team: security / compliance / correctness) on the reply
send path before launch — the key checks: the reply endpoint is admin-gated, can only text the
stored contact phone, and absolutely cannot message a suppressed/opted-out contact.

## Open questions
- Inbox as its own `/inbox` page vs a tab on `/dashboard` — page is cleaner; note the choice.
- Lead status set: the 6 above are a starting point; adjust if Talan's workflow differs.
