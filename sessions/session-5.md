# Session 5 — Dashboard UI

## Objective
One admin-gated screen to run and watch the campaign: status counts, send progress, a live reply
feed, the **leads table** (this is Talan's primary surface for seeing leads), opt-outs, and control
buttons that trigger the already-built skip-trace / scrub / send endpoints. This is Module 5 — pure
UI over the hardened endpoints from Modules 2–4. **No new backend logic, no agent-team review pass
needed** (it adds no compliance-critical code; the dangerous endpoints it calls were already
reviewed and gated in Sessions 3–4).

## Prerequisites
- `CLAUDE.md`, `handoff.md`, `sessions/session-5.md` read in full.
- Modules 1–4 complete. Endpoints exist and are admin-gated: `POST /api/skiptrace`, `POST /api/scrub`,
  `POST/GET /api/campaign`, `POST /api/webhook/twilio`. `lib/db.ts` has the read helpers
  (`getContactCounts`, `getSendProgress`, etc.).
- Admin gate from Session 1 (`isAuthed`, httpOnly cookie) is the auth for this page too.

## Task 0 (quick carry-over) — apply the timezone fix
Before the dashboard work, apply the outstanding one-liner: set the `lib/twilio.ts` send-window
default to `SEND_TIMEZONE` **`America/New_York`** (Tallahassee is Eastern — decided), and update the
recorded decision in `overview.md`. Re-run `npm run build`. Then proceed to the dashboard.

## Scope for this session
Build:
- `app/dashboard/page.tsx` — the dashboard (server component for initial data + client components for
  actions/polling).
- Small `components/*` as needed (cards, feed, leads table, action buttons).
- Thin **read-only** data access only if needed (e.g., a `GET /api/dashboard` that aggregates, or
  direct server-component DB reads via `lib/db.ts`). Reads are fine; do NOT add new write/mutation
  logic — the buttons call the EXISTING endpoints.

Do NOT build:
- Any new send/scrub/trace logic — only call the existing endpoints.
- New auth — reuse the admin gate.
- Anything that bypasses the campaign endpoint's `confirm:true` + send-window guards.

## Detailed specification

### Auth / access
- The page is behind the admin gate — unauthenticated → redirect to the `/` login. (Talan views the
  same dashboard with the shared admin password for MVP; that's acceptable per `overview.md`.)

### Data to show (reads)
- **Count cards:** total contacts, with-phone, suppressed, scrubbed-clean, eligible, sent, failed,
  opted-out, leads. Source: `getContactCounts` + `getSendProgress` (campaign GET) + small read
  queries for leads/opt-out counts. `skiptrace_status` / `scrub_status` breakdowns are useful too.
- **Send progress:** a bar from `getSendProgress` (sent / eligible), plus pending / failed / in_flight.
- **Reply feed:** most-recent inbound messages (`messages` where `direction='inbound'`) joined to
  the contact (name, phone), newest first, with the classified disposition if available.
- **Leads table (primary):** `leads` joined to `contacts` — name, address, reply text, created time,
  and **ping status** (`forwarded` true/false + `forwarded_at`). This is what Talan looks at; make it
  the clearest part of the page.
- **Opt-outs:** count + a small list (most recent) so suppression is visible.

### Control buttons (call existing endpoints)
- **Run skip trace** → `POST /api/skiptrace` (optional small `{limit}` input for a test batch).
- **Run scrub** → `POST /api/scrub`.
- **Dry-run send** → `POST /api/campaign {dryRun:true}` → show eligible count + per-variant split.
  Always offer this BEFORE a real send.
- **Start send (guarded)** → `POST /api/campaign {confirm:true}`. This is the irreversible,
  money/compliance action, so the UI MUST require an explicit confirmation step first — e.g., a modal
  that states "This will text N eligible people" and requires a deliberate click/typed CONFIRM. Surface
  the endpoint's responses clearly: `confirmation_required` (400), `outside_send_window` (409),
  `active run` (409). The send is batched/resumable, so the button runs a batch and the operator can
  run again to continue; show progress via polling the campaign GET.
- Disable/grey the send button when outside the send window or when a run is active (read that state).

### Polling / refresh
- Poll the campaign GET (and counts) on an interval (e.g., 5–10s) while a send is active so progress
  and the reply/lead feeds update live. Keep it simple.

### Style
- Minimal Tailwind, functional over pretty. Cards + tables. Readable on a laptop.

## Constraints
- No file exceeds 500 lines (split components if the page grows).
- No new backend mutation logic — buttons call existing endpoints only.
- Never provide any path that sends without the campaign endpoint's `confirm:true` + window checks.
- Reuse the admin gate; never expose data to an unauthenticated request.

## Acceptance
- Visiting `/dashboard` unauthenticated → redirected to login; authenticated → dashboard renders.
- Count cards, send-progress bar, reply feed, leads table, and opt-out list all show live DB data.
- Buttons hit the right endpoints: skip-trace/scrub trigger; **dry-run** shows eligible + per-variant
  split; **start send** is gated behind an explicit in-UI confirmation and respects the endpoint's
  `confirm`/window/active-run responses (test with dry-run — do NOT fire a real list send to build).
- Timezone Task 0 applied; `npm run build` passes.
- `status.md`, `handoff.md` (→ Session 6), `modules.md` (Module 5 → Done) updated.

## Open questions
- Whether Talan gets his own dashboard login later vs the shared admin password — shared is fine for
  the pilot; note if you want per-user later.
- Pause vs batch-continue — there's no separate pause endpoint; the send is resumable, so "run batch
  / continue" is the MVP model. Note the choice.
