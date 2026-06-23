# Parallel session — pure logic (classifier + SMS templating)

A **single Claude Code session that uses an agent team** to build two independent, dependency-free
libraries in parallel. It pulls the pure-logic pieces forward out of Modules 3 and 4 so they're
done (and well-tested) before the spine needs them — and it can run at the same time as Session 2
(Tracerfy), because it shares no files with it.

- **No external credentials.** No Tracerfy, Twilio, Resend, or DB access. Pure functions only.
- **Why a team here (and not for the spine):** these are two genuinely independent files with
  clean ownership boundaries — the exact case agent teams are good at. The Tracerfy/Twilio/webhook
  spine is sequential and shares `lib/db.ts`, so it stays single-session.

▶ **Run this in Terminal 2**, alongside Session 2 (Tracerfy) in Terminal 1, in the same repo.
The only file both touch is `package.json` (test runner here, npm scripts there) — commit Session 1
first, and after both finish confirm both sets of scripts survived in `package.json`. No credentials
needed for this session.

## Prerequisites
- `CLAUDE.md`, `handoff.md`, and `sms-copy.md` read in full.
- Session 1 complete (scaffold + `lib/db.ts` exist; you will NOT modify `lib/db.ts` here).
- **Agent teams enabled in Claude Code:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in your
  `settings.json` or environment. If the team tools aren't available when you try to spawn, stop
  and tell the user to set that flag and restart, or fall back to building both files sequentially
  in this one session.

## Team structure
Lead (you) + 2 teammates on **Sonnet**, with non-overlapping file ownership so there are no edit
conflicts:

| Agent | Owns | Builds |
|-------|------|--------|
| **classifier** (teammate) | `lib/classify.ts`, its test file | reply interest + opt-out detection |
| **templating** (teammate) | `lib/sms.ts`, its test file | message rendering + segment/name guards |
| **lead** (you) | `package.json` (test runner), review | wiring, compliance review, make tests+build pass |

The **lead does not implement the libs** — spawn the teammates, set up the test runner, then
review. Wait for both teammates to finish before finalizing. Only the lead edits `package.json`
(both teammates need a test command but must not both edit that file).

## Contracts to build (stable signatures — Sessions 3 & 4 will import these)

### `lib/classify.ts` — classifier teammate
- `isOptOut(body: string): boolean`
  - Comprehensive, case-insensitive, trimmed match of the CTIA opt-out keyword set: STOP, STOPALL,
    "STOP ALL", UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, "OPT OUT", REMOVE (plus common variants).
  - **Fail safe:** when intent is ambiguous, lean toward treating it as an opt-out — a false
    positive (suppressing someone who didn't mean to opt out) is far safer than a false negative
    that keeps texting someone who said stop. Document the exact rule chosen in a comment.
  - This is the most compliance-critical function in the session; test it hardest.
- `classifyInterest(body: string): "interested" | "not_interested" | "neutral"`
  - Keyword/heuristic for MVP. interested: yes / sure / interested / "how much" / quote / pricing /
    "when can you" / scheduling questions. not_interested: no / "no thanks" / "not interested" /
    "remove me". neutral: anything ambiguous. Document the heuristic; bias unclear cases to neutral
    (human handoff decides), never to a false "interested" that spams the client.
- Pure, synchronous, no side effects, no imports beyond stdlib.

### `lib/sms.ts` — templating teammate
- Variant templates A / B / C sourced from `sms-copy.md` (that file is the source of truth for copy).
- `renderMessage(variant: "A"|"B"|"C", contact: { firstName?: string|null; zip?: string|null },
  bizName: string): string`
  - Merge `[NAME]`, `[BIZ]`, `[ZIP]/[neighborhood]`. Every rendered message MUST end with the
    opt-out phrase "Reply STOP to opt out." (hard requirement — assert it in tests).
  - Non-human-name fallback: if the first name is missing or looks like an entity, greet with
    "Hi there" rather than "Hi LLC".
- `isNonHumanName(name?: string|null): boolean` — detects empty/entity/odd names (LLC, INC, LLP,
  TRUST, ESTATE, CORP, ASSOC, all-caps multi-word entities, numerics, etc.).
- `segmentInfo(message: string): { length: number; segments: number; encoding: "GSM-7"|"UCS-2" }`
  and `withinSingleSegment(message: string): boolean` — GSM-7 160 / 153-per-part, UCS-2 70 / 67.
- Pure, synchronous, no side effects.

## Test requirements
- A real unit-test file per lib, runnable via one command (`npm test`).
- **Test runner:** prefer the zero-extra-dependency path — Node's built-in `node:test` run through
  `tsx` (already a dependency) — unless the lead has a strong reason to add `vitest`. Keep deps
  minimal per CLAUDE.md; record the choice.
- Required cases (non-exhaustive):
  - `isOptOut`: every keyword + casing/whitespace variants; "please stop"; a normal interested
    reply must NOT trigger it; document and test the ambiguous-leans-opt-out rule.
  - `classifyInterest`: clear interested / not / neutral examples; ambiguous → neutral.
  - `renderMessage`: all three variants; with a normal name; with a null/entity name (fallback
    fires); assert the opt-out phrase is present in EVERY output; assert single-segment for typical
    inputs (flag any variant that overflows).

## Lead's compliance review (before marking done)
1. Every `renderMessage` output — all variants, normal and fallback name — contains the opt-out phrase.
2. `isOptOut` covers the full CTIA set and errs toward over-matching.
3. No variant exceeds one segment for typical first-name/zip inputs (note any that do).
4. `npm test` is green and `npm run build` passes.

## Constraints
- No file over 500 lines. No new heavy dependencies. No DB, no network, no external SDKs.
- Do NOT modify `lib/db.ts`, the schema, or anything in the Tracerfy/Twilio path.
- Teammates must not edit the same file; only the lead edits `package.json`.

## Acceptance
- `lib/classify.ts` and `lib/sms.ts` exist with the signatures above and pass their tests.
- `npm test` green; `npm run build` passes.
- `status.md` updated (this session → Completed, note it was built by an agent team and pulled
  classify/templating ahead of M3/M4), `modules.md` updated (mark the pure-logic pieces done and
  note M3/M4 now consume them), `handoff.md` refreshed. Record the test-runner choice in `overview.md`.

---

## The prompt (copy everything in the block below into Claude Code)

```
Read `CLAUDE.md`, `handoff.md`, `sms-copy.md`, and `sessions/session-pure-logic.md` in full
before doing anything.

This session uses an AGENT TEAM. Confirm team tools are available; if not, tell me to set
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and restart (or, if I say so, build both files
sequentially yourself instead).

Spawn 2 teammates on Sonnet with non-overlapping file ownership, then review — do NOT implement
the libraries yourself:

- Teammate "classifier": build `lib/classify.ts` + a unit-test file. Functions: isOptOut(body)
  (comprehensive CTIA opt-out keyword detection, case/space-insensitive, ambiguity leans toward
  opt-out) and classifyInterest(body) => "interested"|"not_interested"|"neutral" (keyword
  heuristic, ambiguous => neutral). Pure, no imports beyond stdlib. See the contract in
  sessions/session-pure-logic.md.

- Teammate "templating": build `lib/sms.ts` + a unit-test file. Functions: renderMessage(variant,
  contact, bizName) using variants A/B/C from sms-copy.md (EVERY output must end with "Reply STOP
  to opt out."; non-human/empty name => "Hi there" fallback), isNonHumanName(name), segmentInfo()
  and withinSingleSegment(). Pure. See the contract in the spec file.

As lead: set up a single `npm test` command (prefer node:test via tsx — keep deps minimal; record
the choice), wait for both teammates to finish, then run the compliance review from the spec:
every rendered message contains the opt-out phrase; isOptOut covers the full CTIA set and
over-matches on ambiguity; no variant exceeds one segment for typical inputs; `npm test` green and
`npm run build` passing. Give teammates feedback and have them fix anything that fails.

Do NOT touch lib/db.ts, the schema, or any Tracerfy/Twilio code — out of scope. No file over 500
lines, no heavy new dependencies.

When complete: update `status.md` (this parallel session -> Completed, note it was an agent team
and that classify/templating are now done ahead of Modules 3-4), update `modules.md` accordingly,
refresh `handoff.md`, and record the test-runner choice in `overview.md`.
```
