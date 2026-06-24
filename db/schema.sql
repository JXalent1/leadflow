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

-- Campaign runs: one row per send batch.
CREATE TABLE IF NOT EXISTS campaign_runs (
  id              serial PRIMARY KEY,
  started_at      timestamptz DEFAULT now(),
  finished_at     timestamptz,                           -- NULL while running, set on completion (Session 3 review)
  total_eligible  int,
  sent_count      int DEFAULT 0,
  note            text
);

-- Session 3 review addition (idempotent for pre-existing DBs): finished_at lets a
-- concurrent-run guard tell an active run from a finished one, and distinguishes a
-- completed run from one the function timed out mid-loop (finished_at stays NULL).
ALTER TABLE campaign_runs ADD COLUMN IF NOT EXISTS finished_at timestamptz;

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
