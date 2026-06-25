# Module N — No-scrub send mode (per-campaign passthrough)

> Self-contained build prompt. You are **Claude Code** in the LeadFlow repo. The operator runs `/clear`
> before each prompt, so assume no prior context. Cowork writes prompts; you write code. Small module,
> shippable today.

---

## 0. Orientation — read these first
1. `CLAUDE.md` — stack, conventions (≤500 lines/file, fail-closed scrub, NEVER text an opted-out number,
   idempotent/resumable send, secrets via env).
2. `overview.md` — the top decisions (most recent first). Note the 2026-06-25 scrub-provider decision and
   the V6 deliver-then-stop gate.
3. `handoff.md` + `status.md` — current state (v1 pilot shipped; v2 V1–V6 done).
4. The send eligibility + scrub code you'll touch lightly: `lib/db.ts` (`getEligibleContacts`,
   `getContactsForScrub`, `setScrubStatus`, `claimForSend`), `lib/scrub.ts` (`scrubBatch`),
   `app/api/scrub/route.ts`, `app/api/campaigns/route.ts` (the CSV uploader / campaign create),
   `lib/csv-import.ts`, and `components/pipeline-runner.tsx` (the trace→scrub→send driver).

**Read those before coding.**

---

## 1. Why this module exists
Some campaigns will be sent WITHOUT a vendor DNC/litigator scrub — the operator pre-filters the list at
the source and wants to send it as-is. The app currently makes a contact send-eligible only when
`scrub_status='clean'` (set by the scrub stage), so a campaign with no vendor scrub can never send. This
module adds a **per-campaign `scrub_mode='none'`** that satisfies that requirement via a **passthrough**:
the scrub stage marks the campaign's traced contacts clean **without any external call or spend**, leaving
the reviewed eligibility query and all opt-out/STOP suppression **completely unchanged**.

This is a sending-configuration change, not a compliance change — keep the existing technical guarantees
exactly as they are. No legal/TCPA commentary in code or docs.

---

## 2. Goal
A campaign can be set to `scrub_mode='none'`. When it is, the trace→scrub→send pipeline runs normally
except the **scrub stage is a passthrough** that sets `scrub_status='clean'` for that campaign's
traced, with-phone, still-`pending` contacts — no Tracerfy/vendor call, no credits. Default stays
`'vendor'` (the existing Tracerfy scrub), so the Talan pilot and every existing campaign are byte-unchanged.

---

## 3. Scope — do exactly this
1. **Schema:** add `campaigns.scrub_mode text NOT NULL DEFAULT 'vendor'` (allowed values `'vendor'`,
   `'none'`). Idempotent migration; existing rows backfill to `'vendor'`. (Follow the apply-schema rules:
   no `;` inside `--` comments, each statement individually idempotent.)
2. **Passthrough scrub:** add a pure-ish helper (e.g. `lib/scrub-passthrough.ts` or a function in
   `lib/scrub.ts`) `passthroughScrubBatch(clientId, {campaignId, limit})` that, in ONE scoped UPDATE,
   sets `scrub_status='clean'` for that campaign's contacts where `matched`/has-phone AND
   `scrub_status='pending'` (mirror the exact selection `getContactsForScrub` uses, minus the vendor
   call). Returns `{ scrubbed, clean, note }`. NO `getCredits`, NO `submitScrub`, NO `scrub_jobs` row.
3. **Route wiring:** in `app/api/scrub/route.ts`, look up the campaign's `scrub_mode`. If `'none'`, call
   `passthroughScrubBatch(...)` and return the same response shape the driver already expects (so
   `components/pipeline-runner.tsx` needs NO change — it loops the scrub stage until it drains, same as
   today). If `'vendor'`, the EXISTING `scrubBatch(...)` path runs unchanged.
4. **Set the mode on a campaign:** accept an optional `scrubMode` on campaign creation
   (`POST /api/campaigns`, default `'vendor'`) and add a `setCampaignScrubMode(clientId, campaignId, mode)`
   setter + a small `PATCH` (or extend an existing campaign PATCH) so the operator can flip an existing
   campaign. Validate the value (`'vendor'|'none'`), reject anything else.

---

## 4. Load-bearing invariants (must hold — these are the whole point)
- **Eligibility query UNCHANGED.** `getEligibleContacts` still requires `scrub_status='clean'` AND the
  `NOT EXISTS (opt_outs …)` exclusion AND not-suppressed. Passthrough only sets `scrub_status='clean'`;
  it does NOT touch opt-out/suppression logic, so an **opted-out contact is still excluded** even though
  it's marked clean (the opt_outs check is independent). Prove this in a fixture.
- **STOP / opt-out path UNTOUCHED.** No change to the inbound webhook, `claimForSend`'s opt_out re-check,
  or `recordOptOut`/`markSuppressed`.
- **Idempotent / no double-anything.** Passthrough only touches `scrub_status='pending'` rows → re-running
  is a no-op on already-clean rows. The send path's atomic `claimForSend` still guarantees no double-text.
- **Default unchanged.** `scrub_mode='vendor'` (the default) runs the existing Tracerfy `scrubBatch`
  byte-for-byte. Talan's pilot campaign is unaffected.

---

## 5. Do NOT
- Do NOT modify `getEligibleContacts`, `claimForSend`, the send loop, the inbound webhook, or any
  opt-out/STOP logic.
- Do NOT mark an opted-out/suppressed contact eligible (passthrough marks scrub_status only; opt-out
  exclusion stays enforced by the unchanged eligibility/claim checks).
- Do NOT call any external scrub vendor or spend credits on the `'none'` path.
- Do NOT change the default behavior for existing campaigns. No file >500 lines.

---

## 6. Acceptance
- `npx tsc --noEmit` clean; `npm run build` green; `npm test` green; `npm run test:isolation` = 28/28;
  `npm run test:access` = 28; `test:cockpit` + `test:auto-pause` still pass (this module touches none of them).
- **New fixture** (`scripts/test-passthrough.ts` + `npm run test:passthrough`) proving, on a throwaway
  client/campaign with `scrub_mode='none'`: (a) passthrough marks traced+with-phone `pending` contacts
  `clean` with NO vendor call/credit use; (b) a contact whose phone is in `opt_outs` is marked clean by
  passthrough yet is STILL excluded by `getEligibleContacts` (the safety check); (c) a `pending` contact
  with no phone is NOT marked clean; (d) `scrub_mode='vendor'` still routes to the existing `scrubBatch`.
  Clean up all fixture rows (live DB pristine after).
- A live HTTP smoke: create a `scrub_mode='none'` campaign, upload 2 contacts, confirm the scrub stage
  marks them clean with no Tracerfy call, then delete the test campaign.
- Update `status.md`, `overview.md` (a brief decision entry), `modules-v2.md` (Module N → done), and
  rewrite `handoff.md`.

---

## 7. After it passes
This touches send-eligibility, so a quick **single-reviewer correctness pass**: confirm passthrough only
sets `scrub_status` on the right scoped rows, the eligibility query is unchanged, and an opted-out contact
is still excluded after passthrough marks it clean. (Framed as correctness, not legal.)
