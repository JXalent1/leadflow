# LeadFlow

## Purpose
A lightweight, self-hosted SMS lead-generation tool for home-service businesses. It skip-traces a homeowner list, runs an SMS outreach campaign, captures and triages replies, and forwards qualified leads to the client (first client: Talan, a Tallahassee window-cleaning operator). Built to prove conversion on a 500-record pilot before scaling.

## Goals
- Launch a first SMS campaign to ~500 Tallahassee homeowners and measure delivery, reply, positive-reply, and opt-out rates.
- Auto-handle inbound replies: classify interest, honor STOP instantly, forward hot leads to Talan.
- Keep the whole thing free/cheap to host (Vercel + serverless + a free-tier DB).

## Scope

**In scope (MVP):**
- CSV upload + Tracerfy skip-trace integration (append mobile numbers).
- DNC + litigator scrub step (via Tracerfy scrub endpoint) with hard suppression of flagged numbers.
- Twilio outbound SMS send, paced/throttled, from an aged 10DLC-registered number.
- Inbound reply webhook: STOP/opt-out handling + interest classification.
- Lead forwarding to Talan (SMS and/or email) when a reply signals interest.
- A basic dashboard: list status, send progress, live reply feed, opt-out count, lead count.

**Out of scope (for MVP):**
- Multi-tenant / multi-client accounts (single campaign, single client for now).
- Billing, auth beyond a single admin password.
- AI-generated reply conversations (MVP uses keyword/classifier triage + human handoff; richer AI qualifier is a later module).
- Number rotation / multi-number pools (single aged Twilio number for the pilot).

## Stack / Tools
- **Frontend/host:** Next.js (App Router) on Vercel free tier.
- **Backend:** Next.js API routes / serverless functions.
- **DB:** Neon Postgres free tier, provisioned via the Vercel Marketplace integration (driver: `@neondatabase/serverless`). Stores contacts, messages, opt-outs, leads.
- **SMS:** Twilio API (aged 10DLC-registered number, already verified).
- **Skip trace + scrub:** Tracerfy API — https://www.tracerfy.com/skip-tracing-api-documentation/
- **Lead forwarding:** Twilio SMS to Talan and/or email (Resend free tier).

## Stakeholders
- **Jordan** — builder/owner (DRX). Runs the platform.
- **Talan** — first client (Tallahassee window cleaning). Receives forwarded leads.

## Key Decisions
_Running log. Most recent on top. Format: `YYYY-MM-DD — decision — why`._

- 2026-06-22 — Build sequentially (one coding-agent session per module), reserve a parallel agent-team for the security/compliance review pass on the sensitive modules (suppression, STOP, send path) — modules are a dependency chain that don't parallelize for building, but the suppression/STOP logic benefits from multiple independent reviewers.
- 2026-06-22 — DB = Neon Postgres via the Vercel Marketplace integration (driver: `@neondatabase/serverless`) — Vercel retired first-party "Vercel Postgres" and migrated those DBs to Neon in late 2024, so Neon is now the native Postgres-on-Vercel option (auto-provisions `DATABASE_URL`/`POSTGRES_*` into the project = deploy + DB in one place). The old `@vercel/postgres` driver is deprecated/unmaintained; new projects use `@neondatabase/serverless`.
- 2026-06-22 — Single aged Twilio 10DLC number for pilot, no rotation — keep MVP simple; rotation is a scale concern, not a pilot one.
- 2026-06-22 — Tracerfy for both skip trace AND DNC/litigator scrub — one API, scrub includes federal DNC + state DNC + DMA + TCPA-litigator flags in one pass.
- 2026-06-22 — Source list from Leon County certified tax roll (free), filtered to owner-occupied (homestead exemption) single-family in 5 target zips — free, clean owner-occupied signal vs. paying 10¢/record.
- 2026-06-22 — Test list = random 500 from 5 zips (32312, 32309, 32308, 32317, 32311), entity owners stripped — pilot to validate conversion before spending on a full pull.
- 2026-06-22 — MVP triage is keyword/classifier + human handoff, not full AI conversation — prove the funnel first; AI qualifier is a fast-follow module.

## Compliance note (read before sending)
This pilot sends cold SMS to homeowners who have not opted in. The Tracerfy scrub removes DNC-registered and known-litigator numbers, which reduces risk, but does not constitute consent. TCPA/Florida FTSA exposure is real and is being accepted knowingly for the pilot. Operating discipline that keeps risk lowest: (1) never send to a scrub-flagged number, (2) honor STOP instantly and permanently, (3) keep message content soft, identified, and single-segment with opt-out language, (4) pace sends. These are enforced in the build, not optional.
