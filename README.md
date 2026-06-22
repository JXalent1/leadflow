# LeadFlow — start here

Self-hosted SMS lead-gen tool for home-service businesses. First pilot: Talan, Tallahassee window cleaning. This package is the planning + build scaffold, ready to open in Cowork / Claude Code.

## What's in here
- `overview.md` — what the project is, stack, decisions, and the compliance note. Read this.
- `modules.md` — the 6-module build plan and order.
- `CLAUDE.md` — what the coding agent reads every session.
- `sessions/session-1.md` — the first build session spec (others generated one at a time as you go).
- `status.md` / `handoff.md` / `RULES.md` — Cowork working docs; they keep the project resumable.
- `sms-copy.md` — campaign message variants + sending rules.
- `data/tallahassee_test_500.csv` — the 500-record pilot list (owner name + situs address; NO phones yet — Tracerfy appends them in Session 2).

## How to start building
1. Open this folder in Cowork. It will read `handoff.md` and `RULES.md` first.
2. Gather the pending inputs listed in `status.md` (DB choice + URL, Tracerfy key, Twilio creds, Talan's forwarding contact).
3. Run the Session 1 kick-start prompt (below) in Claude Code.
4. Come back to Cowork after each session to generate the next one.

## Session 1 kick-start (paste into Claude Code)
```
Read `CLAUDE.md` and `sessions/session-1.md` in full before writing any code.

Your scope for this session is ONLY Module 1 (Scaffold + data model + DB). Do not:
- Work on any other module.
- Create files larger than 500 lines.
- Make any Tracerfy or Twilio API calls.

Execute the specification in `sessions/session-1.md`. If anything is ambiguous, stop and ask before coding.

When complete:
- Update `status.md`: move Session 1 from "Next up" to "Completed" with today's date, note any deviations.
- Rewrite `handoff.md` so the next session can pick up cleanly.
- Flag any discoveries that should update `CLAUDE.md`.
```

## The run order once built (Session 6)
import CSV → skip trace (Tracerfy) → scrub DNC/litigator → smoke send to your own phone → paced full send → watch dashboard → capture delivery / reply / positive-reply / opt-out.

## One reminder
The scrub removes DNC + litigator numbers, which lowers risk — it does not create consent. Suppression of flagged numbers and instant STOP handling are built in as hard requirements. Keep them that way.
