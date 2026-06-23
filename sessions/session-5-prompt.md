# Session 5 — kick-start prompt

Paste into **Claude Code** (project root) to build Module 5. Full spec: `sessions/session-5.md`.
Single focused session — **no agent-team review pass** (pure UI over already-hardened endpoints, no
new compliance-critical code).

---

## Before you paste this
- Nothing new in `.env.local` needed for the build.
- The dashboard triggers real money/compliance endpoints, so the build/tests use **dry-run** — do
  NOT fire a real list send to verify.

---

## The prompt (copy everything in the block below)

```
Read `CLAUDE.md`, `handoff.md`, and `sessions/session-5.md` in full before writing any code.

Your scope is ONLY Module 5: the dashboard UI (plus the one-line timezone carry-over). Do NOT:
- Add any new send/scrub/trace/mutation logic — the buttons call the EXISTING endpoints only.
- Add new auth — reuse the Session 1 admin gate (isAuthed).
- Provide any send path that bypasses the campaign endpoint's confirm:true + send-window guards.
- Create any file over 500 lines (split components if needed).

TASK 0 (do first): apply the outstanding one-liner — set the lib/twilio.ts send-window default to
SEND_TIMEZONE = America/New_York (Tallahassee is Eastern; decided), update the recorded decision in
overview.md, and re-run npm run build.

Then build the dashboard per sessions/session-5.md:
- app/dashboard/page.tsx behind the admin gate (unauthed -> redirect to the / login). Talan uses the
  same shared admin password for MVP.
- Count cards (total / with-phone / suppressed / scrubbed-clean / eligible / sent / failed /
  opted-out / leads), a send-progress bar, a reply feed (recent inbound messages joined to contacts),
  and the LEADS TABLE (leads joined to contacts: name, address, reply text, time, ping status
  forwarded/forwarded_at) — make the leads table the clearest part; it's Talan's main view.
- Control buttons that call existing endpoints: Run skip trace (POST /api/skiptrace, optional
  {limit}), Run scrub (POST /api/scrub), Dry-run send (POST /api/campaign {dryRun:true} -> show
  eligible + per-variant split), and Start send (POST /api/campaign {confirm:true}) behind an
  EXPLICIT in-UI confirmation modal ("This will text N people" + a deliberate confirm). Surface the
  endpoint responses (confirmation_required 400, outside_send_window 409, active-run 409). Disable
  the send button outside the window / while a run is active. Poll the campaign GET + counts every
  ~5-10s while a send is active.
- Reads can be server-component DB reads via lib/db.ts or a thin read-only GET /api/dashboard — reads
  are fine, but add NO new write logic.
- Minimal Tailwind, functional over pretty.

Verify with dry-run only (do NOT send a real list batch). If anything is ambiguous or out of Module 5
scope, STOP and ask.

When complete:
- Confirm npm run build passes and show me how the dashboard reads/looks (a screenshot or the served
  page is ideal).
- Update status.md (Session 5 -> Completed, deviations), rewrite handoff.md for Session 6, set
  Module 5 -> Done in modules.md, and record any decision in overview.md.
```

---

## After Session 5
Back to Cowork for Session 6 — deploy to Vercel + the live pilot run. That's where it all comes
together: set env vars in Vercel, point the Twilio inbound webhook at the deployed
`/api/webhook/twilio`, then run the deferred order on the real list (import → skip trace → scrub →
smoke send → paced full send) and watch the dashboard. The Twilio trial/10DLC check and Talan's copy
sign-off are the gates that must clear before that real send.
