# Session 2 — kick-start prompt

Paste into **Claude Code** (project root) to build Module 2. Full spec: `sessions/session-2.md`.
This is a **spine** session — run it as a single focused session (no agent team).

▶ **Run this in Terminal 1.** Open a **second** Claude Code terminal in the same repo and run
Module P (`sessions/session-pure-logic.md`) at the same time. They edit different files, so they
run in parallel. (Only shared file: `package.json` — see the note at the bottom.)

---

## Before you paste this (~2 min)

1. **Add your Tracerfy key to `.env.local`** (never put it in the prompt or commit it — `.env.local`
   is gitignored):
   ```
   TRACERFY_API_KEY=<paste your Tracerfy key here>
   ```
2. Confirm your Tracerfy account has credits (the smoke test spends 1; the full 500 is a real spend).
3. You do NOT need Twilio, Talan's contact, or the SMS copy for this session — only the Tracerfy key.

---

## The prompt (copy everything in the block below)

```
Read `CLAUDE.md`, `handoff.md`, and `sessions/session-2.md` in full before writing any code.
Then read the live Tracerfy API docs at
https://www.tracerfy.com/skip-tracing-api-documentation/ and confirm the exact endpoint
paths, payload keys, and field names — the docs win over any summary in the spec.

Your scope is ONLY Module 2: Tracerfy skip-trace + scrub. Do NOT:
- Write any Twilio / sending code, or add the Twilio SDK.
- Touch `lib/classify.ts` or any SMS-templating code (those are built in a separate session).
- Build dashboard UI.
- Create any file over 500 lines.
- Run the full 500-record trace before the single-record smoke test passes.

FIRST, verify the highest-risk unknown: our contacts are name + situs address
(first_name, last_name, address, city, state, zip), NOT parcel IDs / APNs. Confirm Tracerfy's
address-based trace input and map our columns to it. If Tracerfy requires APNs instead, STOP
and tell me — the plan changes.

Build exactly what `sessions/session-2.md` specifies:
- `lib/tracerfy.ts` — typed client (getCredits, submitTrace, getTraceResults, submitScrub,
  getScrubResults). Bearer auth from TRACERFY_API_KEY. Every external call wrapped in
  try/catch with logged, typed errors. Async model: submit → poll a queue id → parse results.
- `app/api/skiptrace/route.ts` (POST) — trace contacts where skiptrace_status='pending';
  write phone/phone_type and set skiptrace_status='matched'; for unmatched set
  skiptrace_status='no_match' AND suppressed=true, suppress_reason='no_match' (fail closed).
  Idempotent: re-runs never re-trace matched/no_match rows. Add an additive
  `setTraceResult(...)` helper to lib/db.ts (do not rename existing helpers).
- `app/api/scrub/route.ts` (POST) — scrub matched numbers (prefer scrub-from-queue); for ANY
  of the four flags (Federal DNC, State DNC, DMA, litigator) call markSuppressed with reason
  'litigator' or 'dnc'. Fail closed: missing/ambiguous/errored scrub result => suppress.
- `scripts/smoke-tracerfy.ts` — trace + scrub ONE real pending contact end-to-end against the
  live API; print raw AND parsed shapes. This is the acceptance gate. Load .env.local via
  dotenv. Runnable via `npx tsx` (or an npm script).

Compliance is non-negotiable: a no-match or any scrub flag MUST end as suppressed=true with a
suppress_reason. Never leave an unverified or flagged number eligible to be texted.

If anything is ambiguous or out of Module 2 scope, STOP and ask before coding.

When complete:
- Run the smoke test and paste me the parsed output before any full run.
- Update `status.md` (Session 2 -> Completed, note deviations), rewrite `handoff.md` for
  Session 3, set Module 2 -> Done in `modules.md`, and record any key decision (especially the
  result->contact mapping and address-vs-APN finding) in `overview.md`.
```

---

## Running in parallel — the one thing to watch
Session 2 and Module P edit different files except for **`package.json`** (both may add an npm
script). To avoid a clobber: commit the Session 1 code first as a clean baseline, run both
sessions, then after both finish open `package.json` and confirm BOTH sessions' scripts are
present (re-add any that got overwritten) and run `npm install`. Everything else is conflict-free.

---

## After Session 2

Come back to Cowork. With phones appended + scrubbed and the pure-logic libs (`classify.ts`,
`sms.ts`) already built in parallel, Session 3 (Twilio send engine + suppression) becomes the
next spine session — and it's where the **parallel security/compliance review team** first
earns its keep.
