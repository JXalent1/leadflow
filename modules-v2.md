# LeadFlow v2 — Multi-tenant build plan

_Started 2026-06-24. v1 (the Talan pilot) is built + live. v2 turns it into the product._

## The model (drives every decision)
- **Agency / done-for-you.** YOU operate LeadFlow and run campaigns for clients. Clients don't run
  anything — they get a branded dashboard to watch leads come in.
- **Billing:** flat **$2,500/month** per client retainer with a **minimum 50 leads/month guarantee.**
- **Central metric:** *leads this month vs. the 50 guarantee*, per client. This is the heartbeat of the
  whole app — the operator cockpit and the client view both revolve around it.

## Build order (one module = one Claude Code session, generated one at a time)

| # | Module | Why / what |
|---|--------|-----------|
| V1 | **Multi-tenant foundation** ✅ **DONE (2026-06-24)** | `clients` table (name, status, plan $, lead_guarantee=50, billing_day, branding) + a `client_id` on every table (contacts, messages, leads, opt_outs, campaign_runs, trace_jobs, scrub_jobs) + scope EVERY query by client. Talan migrated in as client #1 (behavior identical). Per-client config (Twilio number, message copy, forward contact, send window/rate, opt-out copy) moved env→client record; webhook routes by To→client. Built + green (npm run schema/build/test, 160 unit tests, 22-assertion isolation fixture) AND **review-clean** — the 3-reviewer client-isolation pass found no Critical/High; 5 Medium/Low fixes applied. One logged gate: `?clientId=` needs per-client access control before a 2nd client (that's V5). **Ready for V2.** |
| V2 | **Campaigns + list uploader** | A `campaigns` table (a client runs many campaigns over time). A **CSV uploader** so you drop a list into a client and go — no more scripts. |
| V3 | **Guided pipeline + de-finicky** | One-click **upload → trace → scrub → send** with live progress + **auto-resume** (kills the babysitting). **Live send-rate control** (no redeploy). Fix the **send-batch stall** (run not closing) + the **"undefined sent/failed"** counter. |
| V4 | **Lead-guarantee cockpit (operator)** | Per-client **leads-this-month / 50** tracking + an operator home showing every client's progress and **who's behind**, so you know where to push more campaigns. The agency control room. |
| V5 | **Client dashboard + login** | Branded, dead-simple per-client view: leads as they land + progress to 50/mo + lead detail. Per-client **login** (scoped, read-mostly) replacing the shared admin password. |
| V6 | **Billing** | Subscription tracking ($2,500/mo, billing day, active/paused) tied to the guarantee. Stripe for collection (or manual invoicing first — TBD). |
| V7 | **UX redesign + LeadFlow branding** | Make the operator + client UIs look like the product they are. |
| Later | AI auto-responder/qualifier · analytics & ROI · multi-number per client · onboarding flow |

## Principle
Do the **data-model refactor (V1) first.** It touches every table and query, so every feature built
after it is multi-tenant-native. Build features before it and you build them twice.

## Notes carried from v1
- Compliance core (DNC/litigator scrub, instant STOP, suppression, signed webhook) is built + reviewed
  — v2 must preserve it per client (scoping must never let one client's suppression/opt-outs leak or
  be bypassed).
- Known v1 bugs folded into V3: send-batch run not closing, "undefined" counter, inbox orphan-reply gap.
