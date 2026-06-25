# V7 (phase 1) — Operator launch UI: redesign + no-scrub toggle

> Self-contained prompt. You are **Claude Code** in the LeadFlow repo. The operator runs `/clear` before
> each prompt, so assume NO prior context. Cowork writes prompts; you execute. This is mostly a **frontend
> redesign** plus ONE small functional add (a no-scrub toggle wired to an existing param). **Do NOT change
> any send / eligibility / suppression / auth / API behavior.** Keep every test green.

---

## 0. Orientation — read these first
1. `CLAUDE.md` (conventions, ≤500 lines/file, Tailwind, "keep it minimal") + `overview.md` top decisions
   + `handoff.md` + `status.md` + `modules-v2.md` (V7 = "UX redesign + LeadFlow branding").
2. The screens you're redesigning + the launch flow:
   - **Login:** `app/login/*` (the form posts to a server action; on failure → `?error=1`).
   - **Operator cockpit:** `app/page.tsx` + `components/cockpit-view.tsx` + `components/cockpit-billing.tsx`.
   - **Operator dashboard:** `app/dashboard/*` + `components/dashboard-client.tsx` +
     `components/campaign-bar.tsx` (the CSV uploader) + `components/pipeline-runner.tsx` +
     `components/campaign-controls.tsx`.
   - The campaign-create API you'll wire the toggle to: `app/api/campaigns/route.ts` (it ALREADY accepts an
     optional `scrubMode` of `'vendor'|'none'`, default `'vendor'` — Module N) and `lib/campaigns.ts`.
   - `tailwind.config.*` + `app/globals.css` for the theme.

**Read those before touching anything.** The operator finds the current UI unusable; this fixes that for
the launch path. (Client portal `/client` + the inbox are V7 phase 2 — out of scope here, but reuse the
same kit so they're easy later.)

---

## 1. Goals
1. **Make the launch point-and-click.** Add a **no-scrub toggle** to the upload form so the operator can
   create a `scrub_mode='none'` campaign without any command.
2. **Redesign three screens** — login, operator cockpit, operator dashboard — into a clean, consistent,
   trustworthy product UI with real **LeadFlow** branding. The operator should be able to run the whole
   launch by clicking and immediately understand what each screen is telling them.

---

## 2. The functional add — no-scrub toggle (the only behavior change)
- In `components/campaign-bar.tsx`'s create-campaign form, add a clearly-labeled control for the scrub
  mode — e.g. a segmented toggle or select: **"DNC scrub: Standard"** (`vendor`) vs **"No scrub — send
  whole list"** (`none`), default **Standard**. Include one line of helper text so it's unambiguous.
- Wire it to the EXISTING `scrubMode` field on `POST /api/campaigns` (don't change the API or
  `lib/campaigns.ts`). On the campaign selector, show each campaign's mode as a small badge
  (Standard / No-scrub) so the operator can see at a glance which a campaign is.
- (Nice-to-have, only if cheap) a small control to flip an EXISTING campaign's mode via the existing
  `PATCH /api/campaigns {campaignId, scrubMode}`. If it adds risk/size, skip it — the upload-time toggle
  is what the launch needs.

## 3. The redesign — a shared kit, then the three screens
**Build a small shared UI kit first** (so the look is consistent and phase 2 is easy), Tailwind-only, no
new heavy dependencies (simple inline SVG icons are fine):
- A **design system**: pick ONE confident accent and use it consistently. Suggested palette —
  primary `indigo-600` (hover `indigo-700`), success `emerald-600`, warning `amber-500`, danger
  `red-600`, neutrals `slate`. Light theme, generous whitespace, `rounded-lg`/`xl`, subtle
  borders + soft shadows, clear typographic hierarchy (one clean sans — system stack or `next/font` Inter).
- Reusable primitives (e.g. under `components/ui/`): `Button` (primary/secondary/ghost/danger + disabled
  + loading), `Card`, `StatTile`, `Badge` (for pace/mode/status), `Input`/`Field` (label + help + error),
  `Toggle`/`Select`, a `ProgressBar`, and a shared `AppHeader` (LeadFlow wordmark + user email + Log out).
  Keep each file ≤500 lines.

**Login (`app/login`):** center a clean branded card — LeadFlow wordmark/logo, "Sign in", labeled email +
password fields with visible focus states, a full-width primary button with a loading state, and a
non-jarring inline error for `?error=1`. Make it look like a product login, not a raw form.

**Operator cockpit (`app/page.tsx` + `cockpit-view.tsx`):** a real control room. App header; a top summary
strip (clients, # behind pace); each client as a polished card — name, pace **Badge** (behind=amber/red,
on-track/met=emerald), a clean **ProgressBar** to the lead guarantee, the cycle stats (sent / reply rate /
opt-out rate) as small stat tiles, and the billing line (amount · next bill · Paid/Due badge + the
mark-invoiced/paid buttons restyled). Behind-pace sorts first (keep the existing logic). Clicking a card
opens that client's dashboard (unchanged route).

**Operator dashboard (`app/dashboard` + `dashboard-client.tsx` + `campaign-bar.tsx` + `pipeline-runner.tsx`
+ `campaign-controls.tsx`):** make the launch flow obvious and the data scannable. App header + a clear
client/campaign context line. Group the page logically: **(1)** campaign select + the upload form (now with
the scrub toggle); **(2)** the stat tiles (total / with-phone / scrubbed-clean / eligible / sent / pending /
suppressed / opted-out / leads) as a clean responsive grid; **(3)** Send progress as a labeled card with the
ProgressBar + the send-window status; **(4)** Run pipeline with a clearly-labeled rate input + Save + a
prominent primary **Run** button, plus the manual stage controls tucked into a secondary/expandable area.
Keep all existing wiring (the poller, `pipeline-runner` driver, rate PATCH, confirm-to-send) — restyle
only.

## 4. Hard constraints — do NOT
- Do NOT change send / eligibility / suppression / opt-out / auth / cycle / billing logic, or any API
  behavior beyond surfacing the existing `scrubMode` param in the form.
- Do NOT remove the send-confirmation guard, the send-window gate, or any disabled-state safety on buttons.
- Do NOT add heavy UI dependencies. Tailwind + tiny inline SVGs only. No file >500 lines (split components).
- Keep it responsive and accessible (labels tied to inputs, visible focus rings, sufficient contrast).

## 5. Acceptance
- `npx tsc --noEmit` clean; `npm run build` green; `npm test` = 208; `test:isolation` 28/28; `test:access`,
  `test:cockpit`, `test:auto-pause`, `test:passthrough` all pass (this is UI-only + a form field — none
  should change).
- The three screens are visibly redesigned and consistent (shared kit), and the **launch is fully
  point-and-click**: uploading with the toggle set to "No scrub" creates a `scrub_mode='none'` campaign.
  Prove it with a throwaway create (assert the new campaign's `scrub_mode='none'`), then delete it — live
  DB pristine after.
- Commit + push + `vercel --prod` so the operator can review it live at the URL. Report the deployed URL.
- Update `status.md`, `modules-v2.md` (V7 phase 1 → done; note phase 2 = client portal + inbox),
  `overview.md` (a short decision logging the design system + palette), and `handoff.md`.

## 6. After it deploys
The look is subjective — expect the operator to eyeball it and request specific tweaks (spacing, color,
wording, layout). Leave the shared kit clean so iterating is fast. End with the deployed URL + a one-line
"ready for review", and restate the now-click-only launch steps (log in → upload the 2,500 CSV with scrub
toggle = No scrub → set rate → Run).
