-- ARGUS P0 (Kev, 2026-11-21): Safe Draft pool per persona + intent, daily Reminder Due dispatch,
-- inbox read-state dispositions. Additive only.
BEGIN;
-- 1. Safe Drafts: intent, required context, review status, stable code.
ALTER TABLE outreach_library_templates ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE outreach_library_templates ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'new_owner_general';
ALTER TABLE outreach_library_templates ADD COLUMN IF NOT EXISTS required_context TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE outreach_library_templates ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE outreach_library_templates ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE outreach_library_templates ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE outreach_library_templates DROP CONSTRAINT IF EXISTS outreach_library_templates_review_status;
ALTER TABLE outreach_library_templates ADD CONSTRAINT outreach_library_templates_review_status CHECK (review_status IN ('approved','pending_review','rejected'));
CREATE UNIQUE INDEX IF NOT EXISTS outreach_library_templates_code_key ON outreach_library_templates (code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_library_pick ON outreach_library_templates (persona, intent) WHERE active AND review_status = 'approved';

-- 2. Reminder Due: one dispatch record per reminder and Malta day (durable, idempotent).
CREATE TABLE IF NOT EXISTS reminder_dispatches (
  id            BIGSERIAL PRIMARY KEY,
  reminder_id   INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  run_date      DATE NOT NULL,
  owner_phone   TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('planned','sending','sent','skipped','failed','ambiguous','waiting')),
  reason        TEXT,
  intent        TEXT,
  session_name  TEXT,
  persona       TEXT,
  template_id   INTEGER REFERENCES outreach_library_templates(id) ON DELETE SET NULL,
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  rendered_text TEXT,
  planned_at    TIMESTAMPTZ,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sending_at    TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reminder_id, run_date)
);
CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_due ON reminder_dispatches (planned_at) WHERE state = 'planned';
CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_day ON reminder_dispatches (run_date DESC);
-- at most one reminder message per owner phone per day, whatever the number of reminders
CREATE UNIQUE INDEX IF NOT EXISTS reminder_dispatches_one_per_owner_day ON reminder_dispatches (owner_phone, run_date)
  WHERE state IN ('planned','sending','sent','ambiguous');

-- 3. Inbox: why a bot conversation was (or was not) marked read.
CREATE TABLE IF NOT EXISTS owner_inbox_dispositions (
  id          BIGSERIAL PRIMARY KEY,
  session     TEXT,
  chat_id     TEXT,
  phone       TEXT,
  owner_id    INTEGER,
  message_id  TEXT,
  text        TEXT,
  disposition TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_inbox_dispositions_phone ON owner_inbox_dispositions (phone, created_at DESC);

-- 4. The daily run only ever looks at reminders that fall due from this date on (no backlog).
INSERT INTO settings (key, value) VALUES ('reminder_daily_since', '2026-11-22') ON CONFLICT (key) DO NOTHING;
COMMIT;
