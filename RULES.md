# Cowork Rules — this project

These rules apply to any Cowork session working in this folder. Read them at the start of every session.

## At the start of every session
1. Read `handoff.md` first.
2. Then skim `status.md` for current task state.
3. Read `overview.md` only if context is missing.
4. Confirm the immediate next action with the user before diving in.

## After every completed task
1. Append the task to the **Completed** section of `status.md` with today's date.
2. Remove it from **In progress** or **Next up** if it was listed there.
3. Update the `Last updated` date at the top of `status.md`.
4. If the task involved a meaningful decision (tool choice, architecture, approach, tradeoff), add a line to the **Key Decisions** section of `overview.md`.

## At the end of every session (or when the user says "save" / "handoff" / "end session" / "wrap up")
1. Rewrite `handoff.md` completely — TL;DR, where we left off, immediate next action, open questions.
2. Do not leave `handoff.md` stale. If the project state has changed since last handoff, it gets rewritten.
3. Update the `Last updated` date.

## General conventions
- Keep these docs concise. They're working notes, not a novel.
- Dates use `YYYY-MM-DD` format.
- Never delete completed tasks from `status.md` — the log is the log.
- When in doubt about whether something is worth recording, record it.

---

## Dev mode rules (added by dev-prep)

These rules are active from the start of the build phase onward.

### Cowork's role during dev
- Cowork writes **prompts**, not code. When the user asks for code directly, redirect: "Let's capture that in the session prompt so the coding agent runs it properly."
- Cowork's job is to keep the build plan coherent — module breakdown, session specs, scope enforcement, context maintenance.
- The coding agent (Claude Code or similar) does the actual implementation.

### Session discipline
- One module = one session = one prompt file (`sessions/session-N.md`).
- Do not pre-generate future session prompts. They're generated one at a time, after the previous session completes, informed by what actually got built.
- If a coding session deviates from the spec, update `modules.md` before generating the next session prompt.

### File size
- No source file in this project exceeds 500 lines of code. This is a hard rule, enforced by the coding agent per `CLAUDE.md`.

### Scope enforcement
- Session prompts must state both what's in scope AND what's explicitly out of scope. The "do not" list is as important as the "do" list.

### Compliance is load-bearing
- Suppression of scrub-flagged numbers and instant STOP handling are hard requirements, not nice-to-haves. No session may ship a send path that can text a flagged or opted-out number. If a session's work touches sending, it must respect the suppression list.
