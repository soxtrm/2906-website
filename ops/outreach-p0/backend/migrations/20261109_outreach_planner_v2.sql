-- 20261109_outreach_planner_v2.sql — Outreach Planner V2 (Claude, 2026-11-09).
-- Additive and idempotent. Reverse with 20261109_outreach_planner_v2.down.sql.
-- No existing schedule is changed: every automation config is created
-- DISABLED; the legacy Auto (whatsapp_accounts.outreach_auto_enabled) keeps
-- working for an account until its V2 config is enabled.
BEGIN;

-- 1. One persisted automation configuration per sending account. Tenant-ready:
--    agency_key separates ARGUS (2906) from BENESTATES later; nothing in the
--    engine keys on account names.
CREATE TABLE IF NOT EXISTS outreach_automation_configs (
  account_id        INTEGER PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  agency_key        TEXT NOT NULL DEFAULT '2906',
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  start_date        DATE NOT NULL,
  start_time        TEXT NOT NULL CHECK (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  weekdays          SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',          -- ISO 1=Mon … 7=Sun
  target_base       INTEGER NOT NULL CHECK (target_base BETWEEN 0 AND 40),
  target_variation  INTEGER NOT NULL DEFAULT 0 CHECK (target_variation BETWEEN 0 AND 10),
  pace_base         INTEGER NOT NULL CHECK (pace_base BETWEEN 10 AND 100),
  pace_variation    INTEGER NOT NULL DEFAULT 0 CHECK (pace_variation BETWEEN 0 AND 20),
  shift_minutes     INTEGER NOT NULL DEFAULT 15 CHECK (shift_minutes BETWEEN 0 AND 60),
  window_start      TEXT NOT NULL DEFAULT '08:30' CHECK (window_start ~ '^[0-2][0-9]:[0-5][0-9]$'),
  window_end        TEXT NOT NULL DEFAULT '19:30' CHECK (window_end ~ '^[0-2][0-9]:[0-5][0-9]$'),
  template_mode     TEXT NOT NULL DEFAULT 'persona_rotation' CHECK (template_mode IN ('persona_rotation', 'fixed')),
  template_id       INTEGER,
  sequence_epoch    TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- completed runs before this do not shift the start time
  suspended_reason  TEXT,
  suspended_at      TIMESTAMPTZ,
  suspended_recoverable BOOLEAN,
  version           INTEGER NOT NULL DEFAULT 1,
  updated_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (target_variation <= target_base OR target_base = 0),
  CHECK (pace_base - pace_variation >= 10 AND pace_base + pace_variation <= 100)
);
CREATE INDEX IF NOT EXISTS idx_outreach_automation_enabled ON outreach_automation_configs(enabled) WHERE enabled;

-- 2. Run truth on the existing day plan (one plan per account and Malta day).
ALTER TABLE outreach_plans
  ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS sequence_index INTEGER,
  ADD COLUMN IF NOT EXISTS target_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS pace_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS preflight_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS outcome_reason TEXT,
  ADD COLUMN IF NOT EXISTS accepted_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE outreach_plans ADD CONSTRAINT outreach_plans_run_mode CHECK (run_mode IN ('manual', 'automation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outreach_plans ADD CONSTRAINT outreach_plans_outcome
    CHECK (outcome IS NULL OR outcome IN ('completed', 'partial', 'no_sends', 'skipped', 'cancelled', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_outreach_plans_automation_due
  ON outreach_plans(scheduled_at) WHERE run_mode = 'automation' AND status IN ('scheduled', 'preflight');

-- Backfill the outcome of finished plans from their entries (accepted = sent).
UPDATE outreach_plans p SET
  accepted_count = s.sent, failed_count = s.failed, skipped_count = s.skipped,
  last_accepted_at = s.last_sent,
  outcome = CASE WHEN s.sent = 0 THEN 'no_sends' WHEN s.sent < s.attempted THEN 'partial' ELSE 'completed' END
FROM (
  SELECT plan_id,
         COUNT(*) FILTER (WHERE send_status = 'sent')::int AS sent,
         COUNT(*) FILTER (WHERE send_status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE eligibility_status = 'skip' OR send_status = 'skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE eligibility_status = 'eligible')::int AS attempted,
         MAX(sent_at) AS last_sent
    FROM outreach_plan_entries GROUP BY plan_id
) s
WHERE s.plan_id = p.id AND p.status = 'completed' AND p.outcome IS NULL;
UPDATE outreach_plans SET outcome = 'no_sends' WHERE status = 'completed' AND outcome IS NULL;
UPDATE outreach_plans SET outcome = 'cancelled' WHERE status = 'cancelled' AND outcome IS NULL;

-- 3. Run activity timeline (preflight checks, dispatch, reconciliation).
CREATE TABLE IF NOT EXISTS outreach_run_events (
  id         BIGSERIAL PRIMARY KEY,
  plan_id    INTEGER REFERENCES outreach_plans(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind       TEXT NOT NULL,
  ok         BOOLEAN,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_outreach_run_events_plan ON outreach_run_events(plan_id, at);
CREATE INDEX IF NOT EXISTS idx_outreach_run_events_account ON outreach_run_events(account_id, at DESC);

-- 4. Templates: review state and purpose. Existing rows stay approved, except
--    the wording the founder rejected on 2026-11-09 ("I'm reaching out to
--    owners who may have…"), which becomes inactive (kept, not deleted).
ALTER TABLE outreach_persona_templates
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'first_contact',
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE outreach_persona_templates ADD CONSTRAINT outreach_persona_templates_status CHECK (status IN ('draft', 'approved', 'inactive'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE outreach_persona_templates ADD CONSTRAINT outreach_persona_templates_purpose CHECK (purpose IN ('first_contact', 'follow_up', 'rental', 'sale'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
UPDATE outreach_persona_templates SET status = 'inactive', active = FALSE, updated_by = 'planner-v2-20261109'
 WHERE body ILIKE '%reaching out to owners who may have%' AND status <> 'inactive';

-- Founder-supplied first contact (Gabriela, 2026-11-09): approved. Kevin and
-- Cedric versions follow the same structure and stay DRAFT until approved in
-- the Templates view. Paragraph breaks are part of the body.
INSERT INTO outreach_persona_templates(persona, period, slot, body, status, purpose, title, updated_by, approved_by, approved_at) VALUES
 ('gabriela', 'morning', 5, E'Good morning,\n\nI hope you are doing well.\n\nMy name is Gabriela, and I am a real estate agent based in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nGabriela', 'approved', 'first_contact', 'Gabriela — Professional Owner Introduction', 'planner-v2-20261109', 'founder-2026-11-09', NOW()),
 ('gabriela', 'afternoon', 5, E'Good afternoon,\n\nI hope you are doing well.\n\nMy name is Gabriela, and I am a real estate agent based in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nGabriela', 'approved', 'first_contact', 'Gabriela — Professional Owner Introduction', 'planner-v2-20261109', 'founder-2026-11-09', NOW()),
 ('gabriela', 'evening', 5, E'Good evening,\n\nI hope you are doing well.\n\nMy name is Gabriela, and I am a real estate agent based in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nGabriela', 'approved', 'first_contact', 'Gabriela — Professional Owner Introduction', 'planner-v2-20261109', 'founder-2026-11-09', NOW()),
 ('kev', 'morning', 5, E'Good morning,\n\nI hope you are doing well.\n\nMy name is Kevin, and I am an independent real estate agent working with 2906 Estate in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nKevin', 'draft', 'first_contact', 'Kevin — Professional Owner Introduction', 'planner-v2-20261109', NULL, NULL),
 ('kev', 'afternoon', 5, E'Good afternoon,\n\nI hope you are doing well.\n\nMy name is Kevin, and I am an independent real estate agent working with 2906 Estate in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nKevin', 'draft', 'first_contact', 'Kevin — Professional Owner Introduction', 'planner-v2-20261109', NULL, NULL),
 ('kev', 'evening', 5, E'Good evening,\n\nI hope you are doing well.\n\nMy name is Kevin, and I am an independent real estate agent working with 2906 Estate in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nKevin', 'draft', 'first_contact', 'Kevin — Professional Owner Introduction', 'planner-v2-20261109', NULL, NULL),
 ('cedric', 'morning', 5, E'Good morning,\n\nI hope you are doing well.\n\nMy name is Cedric, and I am a rental agent with QuickLets in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nCedric', 'draft', 'first_contact', 'Cedric — Professional Owner Introduction', 'planner-v2-20261109', NULL, NULL),
 ('cedric', 'afternoon', 5, E'Good afternoon,\n\nI hope you are doing well.\n\nMy name is Cedric, and I am a rental agent with QuickLets in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nCedric', 'draft', 'first_contact', 'Cedric — Professional Owner Introduction', 'planner-v2-20261109', NULL, NULL),
 ('cedric', 'evening', 5, E'Good evening,\n\nI hope you are doing well.\n\nMy name is Cedric, and I am a rental agent with QuickLets in Malta.\n\nI wanted to kindly ask whether you currently have any properties available for rent or sale, or perhaps anything coming onto the market soon, that could be suitable for some of my clients.\n\nThank you for your time, and I wish you a lovely week.\n\nKind regards,\nCedric', 'draft', 'first_contact', 'Cedric — Professional Owner Introduction', 'planner-v2-20261109', NULL, NULL)
ON CONFLICT (persona, period, slot) DO NOTHING;

-- 5. A disabled V2 config for every outreach account, prefilled from its
--    current settings so the Automation view shows real values.
INSERT INTO outreach_automation_configs
  (account_id, enabled, start_date, start_time, target_base, target_variation, pace_base, pace_variation, updated_by)
SELECT a.id, FALSE, (NOW() AT TIME ZONE 'Europe/Malta')::date + 1, '08:30',
       LEAST(40, GREATEST(0, ROUND((COALESCE(a.outreach_daily_target_min, 30) + COALESCE(a.outreach_daily_target_max, 40)) / 2.0)::int)),
       0,
       LEAST(100, GREATEST(10, ROUND((COALESCE(a.outreach_pace_min, a.outreach_volume_percent, 30) + COALESCE(a.outreach_pace_max, a.outreach_volume_percent, 30)) / 2.0)::int)),
       0, 'migration-20261109'
  FROM whatsapp_accounts a
 WHERE a.outreach_enabled = TRUE
ON CONFLICT (account_id) DO NOTHING;

COMMIT;
