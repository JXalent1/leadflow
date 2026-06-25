# Module S — Litigator-only scrub via TCPA Litigator List

> Self-contained build prompt. You are **Claude Code** working in the LeadFlow repo. The operator
> (Jordan) runs `/clear` before each prompt, so this file assumes no prior context. Cowork writes the
> prompts; you write the code. Do the module below, keep everything green, update the docs.

---

## 0. Orientation — read these first (in order)

1. `CLAUDE.md` — stack, conventions, hard rules (≤500 lines/file, fail-closed scrub, never text a
   scrub-flagged/opted-out number, secrets via env, idempotent/resumable sends).
2. `overview.md` — top decision entry dated 2026-06-25 **"replace the full DNC scrub with a
   LITIGATOR-ONLY scrub via TCPA Litigator List"** is the decision this module implements. Read it.
3. `handoff.md` and `status.md` — current state (v1 pilot shipped; v2 modules V1–V6 done).
4. The current scrub code you will be refactoring: `lib/scrub.ts`, `lib/scrub-logic.ts`,
   `lib/scrub-jobs.ts`, `lib/tracerfy.ts` (the `ScrubResultRow` type + `submitScrub`/`getScrubResults`/
   `getCredits`/`normalizePhone`), and the route `app/api/scrub/route.ts`. Also skim
   `components/pipeline-runner.tsx` (the client-side driver that calls `/api/scrub` in batches).

**Do not start coding until you've read the four files above.**

---

## 1. Why this module exists (context)

The Tracerfy scrub suppressed a contact on **any** flag — federal DNC + state DNC + DMA + litigator —
which removed ~40–50% of every list. In the live pilot's scrub logs the **litigator count was ZERO**:
all of that list loss was the DNC **registry**, none of it actual litigators. The registry scrub is
where both the cost (~$0.02/number) and the volume loss live; the litigator filter removed nothing.

**Decision: decouple them.** Drop the DNC-registry scrub. Keep ONLY the litigator/TCPA scrub, and move
it to a cheaper vendor — **TCPA Litigator List** (~$0.001/number, ~20× cheaper than Tracerfy). Tracerfy
stays the skip-**trace** vendor (it's the cheapest trace, unchanged). Net effect: federal/state-DNC
numbers now pass through as sendable; only actual TCPA litigators/trolls are suppressed.

This is a cost + volume decision. **Do not add legal/compliance commentary** to the code, comments, or
docs — the operator has counsel and has explicitly asked not to be flagged on it. Keep the existing
*technical* fail-closed guarantees exactly as they are (that's correctness, not legal advice).

---

## 2. Goal

Swap the active scrub from "Tracerfy full DNC" to "**TCPA Litigator List, litigator-only**", behind a
**pluggable provider seam** so Tracerfy's scrub stays available (reversible) but inactive by default.
Preserve the fail-closed contract **byte-for-byte**. Touch nothing in the send path, eligibility, opt-out
suppression, or the inbound webhook.

---

## 3. The TCPA Litigator List API (everything you need — no web access required)

- **Base URL:** `https://api.tcpalitigatorlist.com` (env-overridable; backup, emergencies only:
  `https://api101.tcpalitigatorlist.com`).
- **Auth:** HTTP **Basic** — `Authorization: Basic base64("<username>:<password>")`. Creds are an API
  username + password generated in the account, supplied via env (see §6). Never hardcode.
- **Mass scrub endpoint:** `POST /scrub/phones/` — body is **form-urlencoded** (`application/x-www-form-urlencoded`):
  - `phones` = a **JSON-encoded array string** of 10-digit numbers, e.g. `["6319796917","6024223200"]`.
  - `type` = `tcpa` (this is the litigator + TCPA-troll list — exactly what we want). Pass the literal
    string `tcpa`. **Do NOT pass `dnc_fed`, `dnc_state`, or `dnc_complainers`** — those are the registry
    scrubs we are dropping. (Make the type read from env `TCPA_SCRUB_TYPE`, default `tcpa`.)
  - `small_list` = `true` → results return **immediately** in the same response (limit 3000 numbers/call).
    Our lists are 2,000–2,500, so one call per batch. **Chunk to ≤3000 per call** and loop if a batch
    ever exceeds it. (Public rate limit is 5 mass-scrub calls/sec — you will be nowhere near it.)
  - `sub_user` = `leadflow` (optional request marker for their stats; harmless).
- **Success response (small_list):** a `results` collection; each entry has at least:
  ```json
  { "phone_number": "6024223200", "clean": 1 }                       // CLEAN  (not on the list)
  { "phone_number": "6319796917", "clean": 0, "status": "TCPA",
    "status_array": ["tcpa"], "is_bad_number": true }                // MATCH  (litigator/troll)
  ```
  `clean` may come back as number or string (`1`/`0` or `"1"`/`"0"`) — coerce. `phone_number` may be a
  number or string — coerce to string and normalize. Their docs render `results` as a brace-wrapped
  blob; in practice treat it as an **array of entries** but be defensive (handle array OR object map).
- **Error responses you MUST detect and treat as a WHOLE-CALL FAILURE (abort, write nothing):**
  ```json
  { "error": "You do not have enough credits" }
  { "code": "rest_forbidden", "message": "...", "data": { "status": 401 } }   // bad/inactive creds
  ```
  Also any non-2xx HTTP status or network error. On any of these: **throw a typed error** and write
  NOTHING to the DB — the in-scope contacts stay `scrub_status='pending'` and a re-run (after the
  operator funds coins / fixes creds) scrubs them cleanly. Never mass-suppress on a whole-call failure.

A single-number sanity endpoint also exists (`GET /scrub/phone/tcpa/<phone>/<name>`), useful for the
smoke test. Known sample that returns a **match** for `type=tcpa`: `7276089538`. A random unlisted
number returns `clean:1`.

---

## 4. Build — target design (minimal, low-risk seam)

Keep the reviewed fail-closed writer and the pure verdict logic **unchanged** and reuse them. Only the
*source of verdicts* changes.

### 4a. Provider selector
- New `lib/scrub/provider.ts`: `getScrubProvider(): "tcpa-litigator" | "tracerfy"` reading
  `SCRUB_PROVIDER` (default **`tcpa-litigator`**), validated (unknown value → throw at startup).

### 4b. The TCPA Litigator List provider (the new code)
- New `lib/scrub/tcpa-litigator.ts` exposing a **synchronous** function:
  `scrubPhonesTcpa(phones: string[]): Promise<Map<string, ScrubResultRow>>`
  - Normalizes each input to the **same key** `lib/scrub.ts` uses for lookups — i.e. key the returned
    map with `normalizePhone(...)` from `lib/tracerfy.ts` (last-10-digit normalization) so the existing
    `byPhone.get(normalizePhone(c.phone))` in `applyScrubResults` lines up. Send 10-digit numbers to the
    API.
  - Calls `POST /scrub/phones/` with `type` (env, default `tcpa`), `small_list:true`, chunked ≤3000.
  - Maps each result entry into a `ScrubResultRow` with **only** litigator/clean set:
    `litigator = (clean === 0)`, `isClean = (clean === 1)`, and `federalDnc = stateDnc = dma = false`.
    (Because the provider only ever sets `litigator` or `isClean`, the existing `classify()` yields
    **litigator-only** suppression with no change to `classify`.)
  - On any error response from §3 → **throw** a typed error (reuse `InsufficientCreditsError` from
    `lib/scrub-logic.ts` for the no-credits case; add a small `ScrubProviderError` for auth/HTTP/network).
    Throw BEFORE returning any partial map.
- Keep this file focused and ≤500 lines. Pure response-parsing/mapping helpers should be unit-testable
  without the network (export them or put them in a tiny `lib/scrub/tcpa-litigator-parse.ts`).

### 4c. Wire it into `scrubBatch` (branch, don't rewrite)
In `lib/scrub.ts` `scrubBatch(...)`, branch on `getScrubProvider()`:
- **`tcpa-litigator` (default):** skip the Tracerfy credit pre-flight and `submitScrub`/`scrub_jobs`
  durability (the call is synchronous — there is no async queue to orphan). Select pending contacts via
  the existing `getContactsForScrub(clientId, {campaignId, limit})` (which already filters
  `scrub_status='pending'` — the credit-safety fix; keep it). Then:
  `const byPhone = await scrubPhonesTcpa(contacts.map(c => normalizePhone(c.phone)))` and
  `await applyScrubResults(clientId, contacts, byPhone)` — the **same shared fail-closed writer**
  (`markSuppressed` first, then `setScrubStatus`; only an explicit clean verdict → `scrub_status='clean'`).
  If `scrubPhonesTcpa` throws, let it propagate so the route surfaces a clear error and **no contacts are
  written** (they stay pending). Do NOT create a `scrub_jobs` row on this path.
- **`tracerfy`:** the EXISTING path, **byte-identical** (credit pre-flight, `submitScrub`, `scrub_jobs`
  persistence, `ingestScrubQueue`, orphan recovery). Don't touch it.
- `ingestOutstandingScrubJobs(...)` (orphan recovery) is a Tracerfy-async concern — only run it on the
  `tracerfy` path (under `tcpa-litigator` there are no scrub_jobs to recover; calling it would be a
  harmless no-op, but gate it for clarity).

`applyScrubResults`, `classify`, `ingestScrubQueue`, `getContactsForScrub`, `setScrubStatus`,
`markSuppressed` — **unchanged**. The litigator-only behavior falls out of the provider only ever setting
the `litigator` field.

---

## 5. Idempotency / no-double-bill (must hold, same as today)
- Selection stays **pending-only** (`getContactsForScrub` already does `AND scrub_status='pending'`).
  A clean or flagged contact is never re-selected → a re-run never re-scrubs (never re-bills) it.
- Per-contact write order is **suppress-first** (`markSuppressed` then `setScrubStatus`) so a crash leaves
  a contact suppressed (safe) and already excluded from re-billing, never billed-and-unmarked.
- A whole-call failure writes nothing → contacts stay pending → a later re-run scrubs them. Never clean
  without a verdict; never mass-suppress on a transport/credit failure.

---

## 6. Env (global — the scrub account is the operator's, shared across all clients; no per-client schema)
Add to `.env.example` (values blank) and document in `status.md`/`handoff.md`:
- `SCRUB_PROVIDER` — `tcpa-litigator` (default) | `tracerfy`.
- `TCPA_LIST_API_USERNAME`, `TCPA_LIST_API_PASSWORD` — Basic-auth creds (required when provider is
  `tcpa-litigator`; the provider must fail closed with a clear error if either is missing).
- `TCPA_SCRUB_TYPE` — default `tcpa` (litigator + troll only). Leave it `tcpa`.
- `TCPA_LIST_API_BASE` — default `https://api.tcpalitigatorlist.com` (optional override / backup host).

---

## 7. Do NOT
- Do NOT change `getEligibleContacts`, `claimForSend`, the send loop in `app/api/campaign`, the inbound
  webhook, STOP/opt-out handling, or any suppression-by-opt-out logic. This module changes only WHAT the
  scrub step checks.
- Do NOT mark any contact `scrub_status='clean'` without an explicit clean verdict (fail-closed).
- Do NOT delete or break the Tracerfy scrub — keep it selectable via `SCRUB_PROVIDER=tracerfy`.
- Do NOT add `dnc_fed` / `dnc_state` / `dnc_complainers` to the default scrub type — `tcpa` only.
- Do NOT exceed 500 lines in any file. Do NOT run a live scrub on a real list before the smoke passes.
- Do NOT add legal/TCPA commentary to code or docs.

---

## 8. Smoke test (per CLAUDE.md — prove the integration before any real list)
Add `scripts/smoke-tcpa-scrub.ts` (+ an `npm run smoke:tcpa-scrub` script) that, using the live creds,
scrubs a tiny hardcoded set against the real API and prints verdicts — **no DB writes**:
- a known **match** number (`7276089538`) → expect `litigator` (clean=0),
- a clearly clean number (e.g. the operator's own cell, or a random unlisted 10-digit) → expect clean,
- and verifies missing creds / a forced bad cred → a clear typed error (fail-closed), not a silent pass.
If creds are unset, exit non-zero with an explicit "set TCPA_LIST_API_* first" message.

---

## 9. Acceptance (all must pass)
- `npx tsc --noEmit` clean; `npm run build` green.
- New **unit tests** (pure, no network) for the TCPA provider parser/mapper:
  `clean:1 → isClean`, `clean:0 → litigator`, number/string coercion of `clean`/`phone_number`, a phone
  **missing** from the response → `classify` returns `scrub_error` (fail-closed suppress), and each error
  response (`no credits`, `rest_forbidden/401`, non-2xx) → **throws** (no partial map, no clean verdict).
- Existing suites stay green and **unchanged in spirit**: `npm test` (scrub-logic fail-closed + credit
  tests still pass), `npm run test:isolation` = 28/28, `npm run test:access` = 28, `npm run test:cockpit`,
  `npm run test:auto-pause`. (This module doesn't touch isolation/access/cockpit/auto-pause.)
- An assertion (unit or fixture) that under the `tcpa-litigator` provider a suppressed contact's reason is
  **`litigator`** (or `scrub_error` for a missing verdict) and **never `dnc`** — i.e. registry numbers are
  not suppressed.
- A **fixture** proving the whole-call-failure path writes nothing: feed the provider a stubbed
  no-credits/401 response → `scrubBatch` throws, and the in-scope contacts remain `scrub_status='pending'`
  (not clean, not suppressed).
- Live `npm run smoke:tcpa-scrub` passes against the real API once the operator sets creds.
- Client-1 (Talan) structurally unchanged; with `SCRUB_PROVIDER=tcpa-litigator` the scrub now runs
  litigator-only.
- Update `status.md`, mark **Module S → done** in `modules-v2.md`, append a "BUILT" note to the
  2026-06-25 scrub decision in `overview.md`, and rewrite `handoff.md` for the next session. Keep the
  live DB pristine (clean up any test rows).

---

## 10. After it passes → focused review
The scrub decides who is eligible to be texted, so it owes a focused **correctness + fail-closed** review
(single careful reviewer or a 2-lens correctness/compliance team — framed as technical correctness, not
legal). Verify: (1) a contact is `clean` ONLY on an explicit clean verdict; a whole-call failure aborts
and writes nothing (contacts stay pending, never clean, never mass-suppressed); (2) a per-phone missing
verdict → suppressed (fail-closed); (3) litigator-only — DNC-registry numbers pass through; (4)
idempotent / no double-bill (pending-only selection, re-run safe); (5) STOP/opt-out suppression,
eligibility, and the send path are untouched; (6) the Tracerfy path is still byte-identical when selected.
