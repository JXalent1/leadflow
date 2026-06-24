# LeadFlow — v2 Roadmap & Brainstorm

_Started 2026-06-24, right after the Talan pilot (91 sent). A living doc — react, add, reprioritize._

## The shift
From a **single-client pilot** (Talan, one hardcoded campaign) → a **product** that runs compliant
cold-SMS lead-gen for many home-service businesses. "LeadFlow," not "Talan Window Cleaning."

---

## Theme 1 — Stabilize & de-finicky (do FIRST; some blocks the 2,500 run)
- **Send-batch stall** — the run doesn't mark itself "finished," so "Start send" gets blocked and you
  re-click. At 91 it was annoying; at 2,500 it's unusable. **Fix before tomorrow.**
- **"undefined sent / undefined failed"** counter (cosmetic, but looks broken).
- **Live send-rate control** on the dashboard (change rate without a redeploy).
- **One-click pipeline** — trace → scrub → send as a guided flow with progress + auto-resume, instead
  of manual buttons you have to babysit. This is most of the "finicky" feeling.
- **Surface every auto-message for approval** (the opt-out confirmation surprised us — nothing should
  send that you haven't seen).
- **Inbox: handle unknown-number / orphan replies** so every reply is actionable.

## Theme 2 — UX / look & feel
- Visual redesign + LeadFlow branding (it's intentionally functional-not-pretty right now).
- Clearer live metrics: delivery %, reply %, positive-reply %, opt-out % — per campaign.
- Better inbox UX (the reply experience felt clunky).
- Mobile-friendly (you and clients will check this on a phone).

## Theme 3 — Multi-tenant product (the big architectural lift)
- **Data model:** a `clients` table; scope contacts / campaigns / messages / leads / opt-outs by client.
- **Per-client Twilio number + its own A2P 10DLC registration** (operational reality: each client's
  brand needs its own carrier registration — a real onboarding step, not just a config field).
- **Per-client config:** business name, message copy, forward contact, send window, branding.
- **Real auth** (per-client logins) — replaces the single shared admin password.
- **Multiple campaigns per client + a CSV/list uploader.**
- **Billing** if you're selling it (per-seat, per-message, or per-lead).

## Theme 4 — Lead engine & economics (your strategic question)
- **The funnel reality (from the pilot):** ~500 raw → 441 traced (88%) → only ~30% end up **sendable**
  after DNC/litigator scrub. So **2,500 raw ≈ ~750 sendable.**
- **DNC/litigator scrub is a compliance cost, not an optimization to skip.** Litigator scrub
  especially — those numbers belong to people who sue over TCPA for a living; texting them is buying a
  lawsuit. Skipping scrub to ~3x your list trades a bigger list for dramatically higher legal exposure.
- **The real leverage is upstream and downstream, not in skipping compliance:**
  - *Upstream (list quality):* better sources/targeting → higher match rate + lower DNC rate per pull.
  - *Downstream (conversion):* better copy, A/B testing, speed-to-lead, an AI auto-responder/qualifier
    so leads don't go cold.
- **Compliance at scale — flag:** scaling cold SMS ~25x and across multiple clients is a *materially*
  different risk level than a 91-person pilot. TCPA is per-message statutory damages and class-able;
  Florida's FTSA is aggressive. The scrub + instant-STOP + suppression we built are the right
  foundation, but they reduce risk, they don't eliminate it. **Before the bigger / multi-client
  rollout, get a TCPA attorney to review the setup.** (Not legal advice — just a real cost of doing
  this at scale.)

## Theme 5 — Analytics & reporting
- Per-campaign + per-client dashboards; ROI / lead→close attribution (this is how you sell the value
  to clients).

---

## Tomorrow — the 2,500 run (prep)
1. **Fix the send-batch stall first** (Theme 1) — non-negotiable at this volume.
2. **List source?** Where do the 2,500 come from (more Leon County zips? another county? purchased?).
3. **Funnel + budget:** ~2,500 → ~750 sendable; Tracerfy ≈ $90–110 (trace + scrub); Twilio ≈ $6.
4. **Throughput:** confirm your 10DLC daily cap covers it; set the send rate.
5. **Expect ~750 messages, not 2,500** — set Talan's expectations accordingly.

## Open strategic questions
- **Multi-tenant now, or after Talan proves it converts?** (Build the product on a validated funnel,
  or build it speculatively.)
- **Is cold SMS the long-term channel or a wedge** into building opt-in lists over time?
- **Does the sendable yield justify the cost + legal risk,** or does list sourcing need to change?
