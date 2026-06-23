-- LeadFlow schema (Postgres / Neon). snake_case.
-- Idempotent: safe to run repeatedly (IF NOT EXISTS everywhere).

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

-- Session 4 (inbound webhook idempotency): a partial UNIQUE index on twilio_sid lets the
-- inbound logger use INSERT ... ON CONFLICT DO NOTHING as an atomic dedupe gate, so a Twilio
-- webhook retry (same MessageSid) is processed exactly once — no double opt-out / lead / forward.
-- Partial (WHERE twilio_sid IS NOT NULL) because failed outbound sends are logged with a null sid.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_twilio_sid_unique
  ON messages(twilio_sid) WHERE twilio_sid IS NOT NULL;

-- Session 4 review (compliance): one opt-out row per phone. Makes recordOptOut idempotent
-- (INSERT … ON CONFLICT (phone) DO NOTHING) so the STOP-suppression recovery path (re-applied
-- on a Twilio retry after a mid-process crash) can never write duplicate opt-out rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_opt_outs_phone ON opt_outs(phone);
