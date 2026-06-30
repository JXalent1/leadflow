-- LeadFlow schema (Postgres / Neon). snake_case.
-- Idempotent: safe to run repeatedly (IF NOT EXISTS everywhere).
--
-- NOTE on the apply-schema runner: scripts/apply-schema.ts splits this file on the statement
-- separator and strips line comments, running one statement per call. Constraints that follow
-- from that: NO DO/PL-pgSQL blocks (they contain inner separators), every statement must be
-- individually idempotent, and comments must never contain a statement separator character.

-- ===========================================================================
-- v2 MULTI-TENANT FOUNDATION (Module V1, 2026-06-24)
-- ===========================================================================
-- clients is the tenant table. Every data table carries a client_id FK to it and every
-- query is scoped by client_id — no contact, message, opt-out, lead, or job is ever read
-- or written across clients. Per-client send config (number, copy, window, rate, forward
-- contact, opt-out confirmation) lives here, NOT in env (account-level secrets stay in env).
CREATE TABLE IF NOT EXISTS clients (
  id                    serial PRIMARY KEY,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'active',     -- active | paused
  plan_amount_cents     int  NOT NULL DEFAULT 250000,       -- $2,500/mo retainer
  lead_guarantee        int  NOT NULL DEFAULT 50,           -- leads/month guarantee
  billing_day           int,                                -- day-of-month invoices cut (nullable)
  -- Per-client send config (moved out of env in v2):
  from_number           text,                               -- Twilio campaign number (E.164)
  messaging_service_sid text,                               -- optional, preferred over from_number
  biz_name              text,                               -- nullable (Talan's copy carries no brand)
  message_template      text,                               -- approved copy w/ [NAME]/[ADDRESS], {..}=drop-if-long
  forward_phone         text,                               -- where lead pings go (the client's cell)
  send_window_start_hour int NOT NULL DEFAULT 10,           -- local-hour window [start,end)
  send_window_end_hour   int NOT NULL DEFAULT 19,
  send_timezone          text NOT NULL DEFAULT 'America/New_York',
  send_rate_per_hour     int  NOT NULL DEFAULT 60,
  optout_confirmation    text,                              -- CTIA STOP confirmation copy
  branding              jsonb NOT NULL DEFAULT '{}'::jsonb, -- logo/colors for the client dashboard (later module)
  created_at            timestamptz DEFAULT now()
);

-- Migrate Talan in as client #1. Idempotent: explicit id=1, ON CONFLICT DO NOTHING.
-- Values mirror v1's env config exactly so client 1 behaves identically after the refactor:
-- biz_name NULL (copy is brand-less), the verbatim approved template (the { at [ADDRESS]}
-- clause drops only when the line would exceed one GSM-7 segment), 10–19 America/New_York.
INSERT INTO clients (id, name, status, plan_amount_cents, lead_guarantee, from_number,
                     biz_name, message_template, forward_phone, send_window_start_hour,
                     send_window_end_hour, send_timezone, send_rate_per_hour, optout_confirmation)
VALUES (1, 'Talan Window Cleaning', 'active', 250000, 50, '+18508213720',
        NULL,
        'Hey [NAME] busy season is here, we are working close by if you were interested in window cleaning services{ at [ADDRESS]}. Reply STOP to opt out',
        NULL, 10, 19, 'America/New_York', 60,
        'You''re unsubscribed and will receive no more messages. Reply HELP for help.')
ON CONFLICT (id) DO NOTHING;

-- Advance the clients sequence past the manually-seeded id=1 so a future auto-INSERT (when client
-- creation is wired in a later module) gets id>=2 instead of colliding on 1. Idempotent. (v2 V2
-- review: mirrors the campaigns setval below -- avoids a latent PK collision foot-gun.)
SELECT setval(pg_get_serial_sequence('clients', 'id'), GREATEST((SELECT MAX(id) FROM clients), 1));

-- ===========================================================================
-- v2 CAMPAIGNS (Module V2, 2026-06-24)
-- ===========================================================================
-- A client runs MANY campaigns over time. Each campaign owns its own contact list and its own
-- trace -> scrub -> send lifecycle. A contact belongs to exactly one campaign (and thus one
-- client). Suppression stays CLIENT-level by phone: opt_outs are keyed (client_id, phone), and
-- the eligibility query excludes any phone the client has opted out, so opting out of one
-- campaign excludes that phone from ALL of that client's campaigns, current and future.
-- message_template is nullable: a campaign inherits the client's template when null.
CREATE TABLE IF NOT EXISTS campaigns (
  id               serial PRIMARY KEY,
  client_id        int NOT NULL REFERENCES clients(id),
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',   -- draft|ready|tracing|scrubbing|sending|done|paused
  message_template text,                            -- nullable: inherits the client's template when null
  created_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_client ON campaigns(client_id);

-- Migrate the pilot in as campaign #1 under client 1. Idempotent: explicit id=1, ON CONFLICT.
INSERT INTO campaigns (id, client_id, name, status)
VALUES (1, 1, 'Tallahassee pilot', 'sending')
ON CONFLICT (id) DO NOTHING;

-- Advance the serial sequence past the manually-inserted id=1 so the next auto-INSERT (the CSV
-- uploader's createCampaign, which omits id) gets id>=2 instead of colliding on 1. setval(max)
-- leaves nextval at max+1 and is idempotent (re-running just re-sets it to the current max).
-- NOTE: no statement-separator char may appear in this comment block (apply-schema splits on it).
SELECT setval(pg_get_serial_sequence('campaigns', 'id'), GREATEST((SELECT MAX(id) FROM campaigns), 1));

-- Module N (no-scrub send mode, 2026-06-25): a per-campaign scrub_mode. 'vendor' (the default) runs
-- the existing Tracerfy scrub unchanged. 'none' makes the scrub stage a PASSTHROUGH that marks the
-- campaign's traced, with-phone, still-pending contacts scrub_status='clean' with NO vendor call or
-- credit spend. Eligibility + opt-out suppression are UNCHANGED (an opted-out contact stays excluded
-- even when marked clean). Idempotent: existing rows backfill to 'vendor' so the Talan pilot is unchanged.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scrub_mode text NOT NULL DEFAULT 'vendor';

-- Follow-up / re-engagement campaigns (Build: followup-campaigns, 2026-06-30). A follow-up campaign
-- re-texts a PRIOR campaign's non-responders, REUSING their already-traced + already-clean phones
-- (NO re-trace, NO re-scrub, no vendor spend -- that reuse is the whole margin point). source_campaign_id
-- points at the campaign the follow-up audience was drawn from. NULL = a normal/original campaign
-- (today's behavior, unchanged). A follow-up campaign's contacts are seeded straight to send-ready by
-- copying the source contact's phone with skiptrace_status='matched' + scrub_status='clean', then they
-- flow through the EXISTING eligibility/claim/send path unchanged. The follow-up cap per phone is
-- derived from how many follow-up campaigns (source_campaign_id IS NOT NULL) already contain that phone,
-- so re-running an audience is idempotent. Idempotent column add. Talan (client 1) existing campaigns
-- keep source_campaign_id NULL so they stay byte-unchanged.
-- NOTE: no statement-separator character may appear in this comment block (apply-schema splits on it).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS source_campaign_id int REFERENCES campaigns(id);
CREATE INDEX IF NOT EXISTS idx_campaigns_source ON campaigns(source_campaign_id);

-- followup_round is the Nth follow-up to a given source (1, 2, …). It exists ONLY to make follow-up
-- creation safe under concurrency (review fix): two simultaneous create requests both read the same
-- prior_followups and would otherwise each seed the same phones into two campaigns (a double-text).
-- The partial unique index below forbids two follow-up campaigns sharing (client, source, round), so
-- the racing loser fails its INSERT (no contacts seeded) instead of double-seeding — while still
-- allowing legitimate sequential rounds (round 1, round 2 under a cap of 2). NULL for normal campaigns.
-- NOTE: no statement-separator character may appear in this comment block (apply-schema splits on it).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS followup_round int;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_followup_round
  ON campaigns(client_id, source_campaign_id, followup_round)
  WHERE source_campaign_id IS NOT NULL;

-- ===========================================================================
-- v2 PER-CLIENT OPT-OUT KEYWORD (2nd-client onboarding, 2026-06-27)
-- ===========================================================================
-- A client may advertise (and HONOR) an additional opt-out keyword on top of STOP, e.g. Reply 2 to
-- opt out. optout_keyword is the ADDITIONAL trigger (exact-match only, normalized) and NULL means
-- STOP-only behavior (today's behavior, unchanged). optout_instruction is the exact visible line
-- rendered into the message, and NULL derives it from the keyword or the default Reply STOP to opt
-- out. STOP-family keywords keep working unconditionally regardless of these (carriers honor STOP at
-- the carrier level no matter the visible copy, and the classifier keeps STOP authoritative and
-- always-on). Idempotent. Talan (client 1) keeps both NULL so client 1 stays byte-unchanged.
-- NOTE: no statement-separator character may appear in this comment block (apply-schema splits on it).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS optout_keyword     text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS optout_instruction text;

-- ===========================================================================
-- AI CONVERSATIONAL RESPONDER (Build: ai-responder, 2026-06-29)
-- ===========================================================================
-- Per-client conversational-AI config. ai_enabled is OFF by default — the responder ships dark
-- and the operator flips it per client (lib/clients.updateClientConfig), a global env kill switch
-- (AI_RESPONDER_ENABLED) gates ALL clients on top of this. The ai_* text fields shape the system
-- prompt: services offered, the offer/promo, the rep persona (name + tone), and the service area.
-- STOP / the configured opt-out keyword / suppression are handled DETERMINISTICALLY before the AI
-- (lib/inbound) and are never model-dependent. Idempotent. Talan (client 1) keeps ai_enabled=false
-- so client 1 stays byte-unchanged.
-- NOTE: no statement-separator character may appear in this comment block (apply-schema splits on it).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_services text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_offer    text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_persona  text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_location text;

-- Per-contact AI conversation state. ai_status: NULL/'active' (the responder may engage) |
-- 'handed_off' (qualified -> hot lead forwarded -> a human owns it, stop auto-replying) |
-- 'dismissed' (3-strike non-serious -> stop). ai_strikes counts non-serious turns toward the
-- 3-strike rule. The per-conversation turn cap is derived from messages(status='ai_reply'), so
-- no turn-count column is needed. Idempotent. existing rows backfill ai_status NULL / strikes 0.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_status  text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_strikes int NOT NULL DEFAULT 0;

-- Contacts: the homeowner list. Phones are appended later (Session 2, Tracerfy).
CREATE TABLE IF NOT EXISTS contacts (
  id               serial PRIMARY KEY,
  first_name       text,
  last_name        text,
  address          text NOT NULL,
  city             text,
  state            text,
  zip              text,
  phone            text,                                  -- populated in Session 2
  phone_type       text,                                  -- mobile/landline from Tracerfy
  suppressed       boolean NOT NULL DEFAULT false,        -- true if DNC/litigator flagged OR opted out
  suppress_reason  text,                                  -- 'dnc' | 'litigator' | 'opt_out' | 'no_match'
  skiptrace_status text NOT NULL DEFAULT 'pending',       -- pending | matched | no_match
  scrub_status     text NOT NULL DEFAULT 'pending',       -- pending | clean | flagged (Session 3 guard)
  send_status      text NOT NULL DEFAULT 'not_sent',      -- not_sent | sending | sent | failed
  variant          text,                                  -- A | B | C — assigned at send time (Session 3)
  created_at       timestamptz DEFAULT now()
);

-- Session 3 additions, applied idempotently for DBs created before this column existed.
-- scrub_status makes "scrub actually ran and passed" provable per contact, independent of
-- `suppressed` — the eligibility query requires scrub_status='clean'. A matched-but-unscrubbed
-- contact is 'pending' and therefore NOT eligible (fail closed).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS scrub_status text NOT NULL DEFAULT 'pending';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS variant text;

-- Messages: every outbound and inbound SMS.
CREATE TABLE IF NOT EXISTS messages (
  id          serial PRIMARY KEY,
  contact_id  int REFERENCES contacts(id),
  direction   text NOT NULL,                              -- 'outbound' | 'inbound'
  body        text NOT NULL,
  twilio_sid  text,
  status      text,                                       -- twilio status callbacks later
  created_at  timestamptz DEFAULT now()
);

-- Opt-outs: STOP/unsubscribe events. A contact here must also be suppressed.
CREATE TABLE IF NOT EXISTS opt_outs (
  id          serial PRIMARY KEY,
  contact_id  int REFERENCES contacts(id),
  phone       text NOT NULL,
  created_at  timestamptz DEFAULT now()
);

-- Leads: replies that signal interest, forwarded to the client (Talan).
CREATE TABLE IF NOT EXISTS leads (
  id            serial PRIMARY KEY,
  contact_id    int REFERENCES contacts(id),
  reply_text    text,
  forwarded     boolean NOT NULL DEFAULT false,
  forwarded_at  timestamptz,
  status        text NOT NULL DEFAULT 'new',            -- new|contacted|quoted|scheduled|won|lost (Session 7)
  notes         text,                                   -- free-text operator notes (Session 7)
  created_at    timestamptz DEFAULT now()
);

-- Session 7 (inbox / lead tracking): status moves a lead through a simple funnel and
-- notes holds operator scratch text. Applied idempotently for DBs created before these
-- columns existed. status defaults to 'new' so existing lead rows backfill cleanly.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes text;

-- Trace jobs: one row per submitted Tracerfy trace queue. (Hotfix 2026-06-23 — durability.)
-- The Tracerfy queue id used to live only in memory, so a crash/reload between submit and
-- result-write orphaned a PAID batch (results stranded, contacts stuck 'pending'). Persisting
-- (queue_id + the contact_ids submitted) the instant a trace is submitted makes a completed
-- queue re-ingestable by id after a crash — re-reading a queue does NOT re-charge, so recovery
-- is free. status: 'submitted' (paid, not yet written back) | 'ingested' (results applied).
-- A resumable run ingests any 'submitted' job FIRST, then traces only still-'pending' contacts.
CREATE TABLE IF NOT EXISTS trace_jobs (
  id            serial PRIMARY KEY,
  queue_id      bigint NOT NULL,                          -- Tracerfy queue id (poll/re-ingest by this)
  status        text NOT NULL DEFAULT 'submitted',        -- submitted | ingested
  contact_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,       -- contact ids submitted in this job (ingest scope)
  trace_type    text NOT NULL DEFAULT 'normal',           -- normal | advanced
  rows_uploaded int,
  matched       int,                                      -- filled at ingest
  no_match      int,                                      -- filled at ingest
  created_at    timestamptz DEFAULT now(),
  ingested_at   timestamptz                               -- NULL until results are written back
);

-- Recovery query hits this: find paid-but-not-yet-ingested jobs to re-read after a crash.
CREATE INDEX IF NOT EXISTS idx_trace_jobs_status ON trace_jobs(status);

-- Scrub jobs: one row per submitted Tracerfy DNC/litigator scrub queue. (Hotfix 2026-06-23.)
-- Mirrors trace_jobs: the scrub queue id used to live only in memory, so a crash between
-- submit and write-back orphaned a PAID scrub (results lost, contacts stuck 'pending' → would
-- be re-billed on the next run). Persisting (scrub_queue_id + the contact_ids submitted) the
-- instant a scrub is submitted makes a completed queue re-ingestable by id after a crash —
-- re-reading a queue does NOT re-charge. status: 'submitted' (paid, not yet applied) |
-- 'ingested' (verdicts written). A resumable run ingests any 'submitted' job FIRST, then
-- scrubs only still-'pending' contacts.
CREATE TABLE IF NOT EXISTS scrub_jobs (
  id              serial PRIMARY KEY,
  scrub_queue_id  bigint NOT NULL,                        -- Tracerfy DNC queue id (poll/re-ingest by this)
  status          text NOT NULL DEFAULT 'submitted',      -- submitted | ingested
  contact_ids     jsonb NOT NULL DEFAULT '[]'::jsonb,     -- contact ids submitted in this job (ingest scope)
  clean           int,                                    -- filled at ingest
  suppressed      int,                                    -- filled at ingest
  created_at      timestamptz DEFAULT now(),
  ingested_at     timestamptz                             -- NULL until verdicts are written back
);

-- Recovery query hits this: find paid-but-not-yet-ingested scrub jobs to re-read after a crash.
CREATE INDEX IF NOT EXISTS idx_scrub_jobs_status ON scrub_jobs(status);

-- Campaign runs: one row per DRIVEN send. (v2 Module V3: a run now spans the whole
-- client-side-driven send for a campaign, not one HTTP batch — the driver opens a run,
-- sends batch after batch through the same per-batch eligibility + atomic-claim path,
-- heartbeats it each batch, and finishes it when nothing eligible remains.)
CREATE TABLE IF NOT EXISTS campaign_runs (
  id              serial PRIMARY KEY,
  started_at      timestamptz DEFAULT now(),
  finished_at     timestamptz,                           -- NULL while running, set on completion (Session 3 review)
  last_batch_at   timestamptz,                           -- heartbeat: bumped each driven batch (v2 V3)
  total_eligible  int,
  sent_count      int DEFAULT 0,
  note            text
);

-- Session 3 review addition (idempotent for pre-existing DBs): finished_at lets a
-- concurrent-run guard tell an active run from a finished one, and distinguishes a
-- completed run from one the function timed out mid-loop (finished_at stays NULL).
ALTER TABLE campaign_runs ADD COLUMN IF NOT EXISTS finished_at timestamptz;

-- v2 Module V3: last_batch_at is the run heartbeat. The active-run guard measures staleness
-- from COALESCE(last_batch_at, started_at), so a multi-batch driven send that legitimately
-- outlasts the old started_at window stays "active" (keeps blocking a second operator) as long
-- as the driver keeps sending, while a crashed driver's run still goes stale and self-heals.
ALTER TABLE campaign_runs ADD COLUMN IF NOT EXISTS last_batch_at timestamptz;

-- Indexes the send/scrub paths rely on.
CREATE INDEX IF NOT EXISTS idx_contacts_suppressed   ON contacts(suppressed);
CREATE INDEX IF NOT EXISTS idx_contacts_send_status  ON contacts(send_status);
CREATE INDEX IF NOT EXISTS idx_contacts_scrub_status ON contacts(scrub_status);
CREATE INDEX IF NOT EXISTS idx_contacts_phone        ON contacts(phone);

-- v2 NOTE: the Session-4 idempotency unique indexes (messages.twilio_sid, opt_outs.phone) are
-- now created PER-CLIENT in the multi-tenant block at the end of this file (after client_id
-- exists). The single-tenant versions are dropped there. See "v2 client_id" below.

-- ===========================================================================
-- v2 client_id — scope every data table to a tenant (Module V1, 2026-06-24)
-- ===========================================================================
-- Each ADD COLUMN uses DEFAULT 1 so existing rows backfill to client #1 (Talan) and the FK
-- to clients(id=1) — inserted at the top of this file — validates. We then DROP the default
-- so future inserts MUST set client_id explicitly: a forgotten client_id fails loudly instead
-- of silently landing a row in client 1 (a tenant-isolation foot-gun). NOT NULL is enforced.

ALTER TABLE contacts      ADD COLUMN IF NOT EXISTS client_id int NOT NULL DEFAULT 1 REFERENCES clients(id);
ALTER TABLE contacts      ALTER COLUMN client_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_contacts_client ON contacts(client_id);

ALTER TABLE messages      ADD COLUMN IF NOT EXISTS client_id int NOT NULL DEFAULT 1 REFERENCES clients(id);
ALTER TABLE messages      ALTER COLUMN client_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id);

ALTER TABLE opt_outs      ADD COLUMN IF NOT EXISTS client_id int NOT NULL DEFAULT 1 REFERENCES clients(id);
ALTER TABLE opt_outs      ALTER COLUMN client_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_opt_outs_client ON opt_outs(client_id);

ALTER TABLE leads         ADD COLUMN IF NOT EXISTS client_id int NOT NULL DEFAULT 1 REFERENCES clients(id);
ALTER TABLE leads         ALTER COLUMN client_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id);

ALTER TABLE campaign_runs ADD COLUMN IF NOT EXISTS client_id int NOT NULL DEFAULT 1 REFERENCES clients(id);
ALTER TABLE campaign_runs ALTER COLUMN client_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_campaign_runs_client ON campaign_runs(client_id);

ALTER TABLE trace_jobs    ADD COLUMN IF NOT EXISTS client_id int NOT NULL DEFAULT 1 REFERENCES clients(id);
ALTER TABLE trace_jobs    ALTER COLUMN client_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_trace_jobs_client ON trace_jobs(client_id);

ALTER TABLE scrub_jobs    ADD COLUMN IF NOT EXISTS client_id int NOT NULL DEFAULT 1 REFERENCES clients(id);
ALTER TABLE scrub_jobs    ALTER COLUMN client_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_scrub_jobs_client ON scrub_jobs(client_id);

-- Per-client idempotency unique indexes (replace the single-tenant Session-4 versions).
-- Uniqueness is now scoped to (client_id, key): the SAME phone may opt out under two different
-- clients independently, and a Twilio MessageSid is deduped within its owning client. The legacy
-- global-unique indexes are dropped so they can't wrongly forbid a key across clients.
-- ORDER MATTERS (review M1): CREATE the per-client index BEFORE dropping the legacy global one,
-- so that on an existing single-tenant DB there is never an instant with NO uniqueness constraint
-- if apply-schema is interrupted between statements (the two indexes coexist harmlessly meanwhile).
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_twilio_sid_unique
  ON messages(client_id, twilio_sid) WHERE twilio_sid IS NOT NULL;
DROP INDEX IF EXISTS idx_messages_twilio_sid_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_opt_outs_client_phone ON opt_outs(client_id, phone);
DROP INDEX IF EXISTS idx_opt_outs_phone;

-- ===========================================================================
-- v2 campaign_id — scope contacts + campaign_runs to a campaign (Module V2, 2026-06-24)
-- ===========================================================================
-- Same backfill pattern as client_id: DEFAULT 1 backfills existing rows to campaign #1 (the
-- migrated pilot — which is itself under client 1, so the existing client_id=1 rows stay
-- consistent), then DROP the default so a forgotten campaign_id fails loudly. campaigns(id=1)
-- is seeded above, so the FK validates. NOT NULL is enforced. trace_jobs / scrub_jobs are
-- deliberately NOT campaign-scoped (they are pinned by the contact_ids they submitted, and a
-- crash-recovery ingest must work regardless of which campaign is currently being run).
ALTER TABLE contacts      ADD COLUMN IF NOT EXISTS campaign_id int NOT NULL DEFAULT 1 REFERENCES campaigns(id);
ALTER TABLE contacts      ALTER COLUMN campaign_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_contacts_campaign ON contacts(campaign_id);

ALTER TABLE campaign_runs ADD COLUMN IF NOT EXISTS campaign_id int NOT NULL DEFAULT 1 REFERENCES campaigns(id);
ALTER TABLE campaign_runs ALTER COLUMN campaign_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_campaign_runs_campaign ON campaign_runs(campaign_id);

-- ===========================================================================
-- v2 USERS + real per-user login (Module V5, 2026-06-24) — closes the V1 access gate
-- ===========================================================================
-- Replaces the single shared ADMIN_PASSWORD with real accounts. A user is either an OPERATOR
-- (role='operator', client_id NULL — may act on any client) or a CLIENT user (role='client',
-- client_id set — HARD-LOCKED to that client, can never reach another client's data). Passwords
-- are stored ONLY as a scrypt hash (see lib/auth.ts) with no plaintext column. The resolved
-- client for every request now comes from the logged-in user's session, NOT a ?clientId= param.
-- Users are seeded by scripts/seed-users.ts (npm run seed:users) with hashed, env-provided
-- passwords — NOT in this SQL, so no credential is ever committed.
CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  email         text NOT NULL,
  password_hash text NOT NULL,                       -- scrypt$N$r$p$saltB64$hashB64 (never plaintext)
  role          text NOT NULL DEFAULT 'client',      -- 'operator' | 'client'
  client_id     int REFERENCES clients(id),          -- NULL for operator, set for a client user
  created_at    timestamptz DEFAULT now()
);

-- Case-insensitive unique email (also the ON CONFLICT target for the idempotent user upsert).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));

-- ===========================================================================
-- v2 LEAD-TARGET AUTO-PAUSE + BILLING TRACKING (Module V6, 2026-06-25)
-- ===========================================================================
-- Deliver-then-stop: each client has a lead TARGET per period. When the client hits its target for
-- the current period the send path STOPS sending for them (no wasted texts/credits past the goal)
-- and resumes automatically next period. This is a BUSINESS gate layered ON TOP of suppression /
-- eligibility — it is enforced server-side in the send route and never weakens suppression.
--
-- lead_target is NULLABLE: null means "fall back to lead_guarantee" (the contractual number), so a
-- client whose target equals its guarantee needs no extra config (Talan stays 50/month, unchanged).
-- A client can be set to e.g. 15/week by setting lead_target=15, target_period='week'. lead_guarantee
-- stays the cockpit contractual figure while lead_target drives the auto-pause.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS lead_target   int;                            -- null = use lead_guarantee
ALTER TABLE clients ADD COLUMN IF NOT EXISTS target_period text NOT NULL DEFAULT 'month';  -- 'week' | 'month'

-- Billing tracking (track-only, NO Stripe): one row per client per billing cycle. The operator marks
-- a cycle invoiced or paid and collection happens outside the app. amount_cents snapshots the plan
-- amount at the time the invoice is materialized. status: 'due' (default) | 'invoiced' | 'paid'.
CREATE TABLE IF NOT EXISTS client_invoices (
  id            serial PRIMARY KEY,
  client_id     int NOT NULL REFERENCES clients(id),
  period_start  timestamptz NOT NULL,                  -- billing cycle start (= currentCycle.start)
  period_end    timestamptz NOT NULL,                  -- billing cycle end   (= next bill date)
  amount_cents  int NOT NULL,
  status        text NOT NULL DEFAULT 'due',           -- due | invoiced | paid
  invoiced_at   timestamptz,
  paid_at       timestamptz,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_invoices_client ON client_invoices(client_id);
-- One invoice per client per cycle (the ON CONFLICT target for the idempotent materialize).
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_invoices_period ON client_invoices(client_id, period_start);
