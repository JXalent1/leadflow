# Session 3 — Twilio send engine (paced) + suppression

## Objective
Build the outbound SMS engine: select **only eligible** contacts, render the approved copy, send
paced and within allowed hours, log every send, and make the whole thing idempotent/resumable so a
re-run never double-texts. This is Module 3 — the first module that can actually send, so the
suppression/eligibility gate is the load-bearing requirement. **No real campaign send happens in
this session** — the gate is a single smoke message to Jordan's own phone.

## Prerequisites
- `CLAUDE.md`, `handoff.md`, `sessions/session-3.md` read in full.
- Modules 1, 2, and P complete. `lib/db.ts`, the Tracerfy trace/scrub path, and `lib/sms.ts`
  (`renderMessage`, `isNonHumanName`, `segmentInfo`, `withinSingleSegment`) all exist.
- Twilio creds in `.env.local`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
  `TWILIO_FROM_NUMBER=+18508213720` (or a `TWILIO_MESSAGING_SERVICE_SID` if you set one up).
- The full 500 trace/scrub has intentionally NOT been run yet, so there are 0 eligible contacts in
  the DB. That's fine — build against the eligibility logic; the smoke test inserts/uses a single
  known test contact (Jordan's own number) rather than relying on traced data.

## ⚠️ Pre-flight before any REAL send (not blocking this build, but gating the live campaign)
- **Twilio account must be upgraded from trial.** A trial account can only text verified numbers
  and prepends a trial banner — it cannot run the pilot. Confirm paid + that `+18508213720` has
  **A2P 10DLC** registration approved, or carriers will filter the campaign.
- **Talan must sign off** the as-implemented (single-segment) copy in `sms-copy.md`.
These are send-time gates. Building and smoke-testing to your own phone does not require them, but
the `/api/campaign` route must refuse a real run until they're satisfied (see Safety guards).

## Scope for this session
Build:
- `lib/twilio.ts` — Twilio client + send helper + pacing. **Import templating from `lib/sms.ts`;
  do NOT re-implement rendering.**
- `db/schema.sql` + `lib/db.ts` — add the **`scrub_status`** guard (see below) and wire eligibility.
- `app/api/scrub/route.ts` — update so the scrub writes `scrub_status` ('clean' | 'flagged').
- `app/api/campaign/route.ts` — POST: run the paced send to eligible contacts; GET: progress.
- `scripts/smoke-twilio.ts` — send ONE message to Jordan's own phone; the acceptance gate.

Do NOT build:
- Inbound handling / STOP / reply triage / forwarding (Session 4).
- Number rotation, multi-number pools, AI conversation.
- Dashboard UI (Session 5) — the campaign route returns JSON the dashboard will later render.

## Detailed specification

### scrub_status guard (do this FIRST)
- Add column `scrub_status text NOT NULL DEFAULT 'pending'` to `contacts` (values:
  `pending | clean | flagged`). Add it to `db/schema.sql` idempotently
  (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) and apply via `npm run schema`.
- Update `app/api/scrub/route.ts`: on a clean verdict set `scrub_status='clean'`; on any
  flag/suppress set `scrub_status='flagged'` (alongside the existing `suppressed=true` +
  `suppress_reason`). Fail-closed cases (scrub_error) → `scrub_status='flagged'`.
- This makes "scrub actually ran and passed" provable per contact, independent of `suppressed`.

### Eligibility (the load-bearing query)
`getEligibleContacts()` (already in `lib/db.ts`) must select contacts WHERE:
`phone IS NOT NULL AND suppressed = false AND scrub_status = 'clean' AND send_status = 'not_sent'`.
Add `scrub_status='clean'` to the existing query. A contact that is matched but not yet scrubbed
(`scrub_status='pending'`) is **NOT eligible**. This is the hard guarantee — never relax it.

### `lib/twilio.ts`
- Twilio Node SDK client from env. Support either `TWILIO_FROM_NUMBER` or
  `TWILIO_MESSAGING_SERVICE_SID` (prefer the messaging service if set — better for 10DLC).
- `sendOne(to, body)` — wrap in try/catch with typed errors; return `{ sid, status }` or a typed
  failure. Never log the auth token.
- Pacing: a configurable rate (env `SEND_RATE_PER_HOUR`, default ~60). Space sends to honor it.
- Send window: only send within configurable local hours (default 10am–7pm CT, per `sms-copy.md`).
  Expose a `withinSendWindow(now)` helper; the campaign route refuses/pauses outside the window.

### `app/api/campaign/route.ts`
- **POST** — run (or resume) the send:
  - Accept body `{ dryRun?: boolean, limit?: number }`. `dryRun` reports the eligible count and the
    per-variant split WITHOUT sending. Always safe to call.
  - Create a `campaign_runs` row (`total_eligible`, `sent_count`, `note`).
  - For each eligible contact (respecting `limit`): assign an A/B variant (see below), render via
    `renderMessage`, assert `withinSingleSegment` (skip+log any that overflow rather than send a
    2-segment message), `sendOne`, then `recordMessage(outbound)` and set `send_status='sent'`
    (or `'failed'` on error). Honor pacing + the send window.
  - **Idempotency/resumability:** only ever select `send_status='not_sent'`; mark state immediately
    after each send so a crash/re-run never re-texts a contact. This is a hard requirement.
- **GET** — progress JSON: `{ eligible, sent, pending, failed, suppressed, opted_out }` for the
  dashboard.

### A/B variants
- Split the eligible list into equal cells, one variant (A/B/C from `sms-copy.md`) each, per the
  A/B plan. Record which variant each contact got so positive-reply rate can be measured per
  variant later — add `contacts.variant text` (set at send time), idempotent in the schema.
- Keep everything else identical across cells (send time band, pacing).

### `scripts/smoke-twilio.ts` — the gate
- Sends ONE message to **Jordan's own phone** (`SMOKE_TO_NUMBER` in `.env.local`), using
  `renderMessage` so the smoke exercises the real template + opt-out line.
- Prints the Twilio SID + status. Runnable via `npx tsx` / `npm run smoke:twilio`.
- Purpose: prove Twilio auth, the from-number/messaging service, and the rendered single-segment
  message all work before any list send.

## Safety guards (must be in code, not just docs)
- The eligibility query is the single source of who can be texted — never bypass it.
- The campaign POST must refuse a non-dry-run send unless an explicit confirmation is present (e.g.,
  body `{ confirm: true }`) AND the send window check passes — so nobody fires the 500 by accident.
- Never select suppressed, opted-out (Session 4 will populate this), already-sent, or
  `scrub_status != 'clean'` contacts. Treat any uncertainty as ineligible.

## Constraints
- No file exceeds 500 lines. Secrets only via env; never log the token.
- Reuse `lib/sms.ts` and the existing `lib/db.ts` helpers; additive changes only.
- Stay in scope: no inbound/STOP/forwarding, no dashboard, no number rotation.

## Acceptance
- `scrub_status` exists, the scrub route writes it, and eligibility requires `scrub_status='clean'`.
- Smoke send delivers one message to Jordan's phone via `renderMessage` (single segment, opt-out
  line present). SID/status printed.
- `dryRun` reports the correct eligible count and per-variant split (test by inserting a couple of
  fake clean/eligible contacts, or a tiny fixture).
- A re-run never re-texts a contact (idempotent); suppressed / unscrubbed / opted-out / already-sent
  are never selected (prove with a query or a unit check).
- The non-dry-run path refuses without `confirm:true` and outside the send window.
- `npm run build` passes.
- `status.md`, `handoff.md` (→ Session 4), `modules.md` (Module 3 → Done) updated; record the A/B
  variant-tracking and any send-window/pacing decisions in `overview.md`.

## After the build → parallel compliance review
Once the build passes its smoke gate, run `sessions/session-3-review.md` — an agent-team review pass
(security + compliance + correctness) over the finished send path before it ever touches the real
list.

## Open questions
- Messaging Service SID vs bare from-number — use the messaging service if you set one up for 10DLC;
  otherwise the from-number is fine for the pilot. Record which.
- Exact A/B cell count (2 vs 3 variants) — default to the `sms-copy.md` plan; the eligible count
  after scrub may be small, so 2 balanced cells may beat 3 thin ones. Note the choice.
