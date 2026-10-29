'use strict'
// Builds migrations/20261029_outreach_automation.sql from the schema text below
// plus the template seed in services/outreachTemplateSeed.js (single source).
//   node scripts/build-outreach-automation-migration.js
const fs = require('fs')
const path = require('path')
const { seedRows } = require('../services/outreachTemplateSeed')

const q = s => `'${String(s).replace(/'/g, "''")}'`

const UP = `-- 20261029_outreach_automation.sql — ARGUS outreach automation rebuild (Kev, 2026-10-29).
-- Additive and idempotent. Reverse with 20261029_outreach_automation.down.sql.
BEGIN;

-- 1. Pace (the CRM "PACE" control = outreach_volume_percent, 10–100; dispatch
--    delay multiplier = 100 / pace). A saved pace is now a persistent range.
ALTER TABLE whatsapp_accounts
  ADD COLUMN IF NOT EXISTS outreach_pace_min INTEGER,
  ADD COLUMN IF NOT EXISTS outreach_pace_max INTEGER,
  ADD COLUMN IF NOT EXISTS outreach_auto_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS outreach_auto_rolling BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS outreach_auto_horizon_days INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS outreach_daily_target_min INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS outreach_daily_target_max INTEGER NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS outreach_auto_updated_at TIMESTAMPTZ;

-- Bug fix data repair: an expired temporary override used to be READ as 100
-- while the saved value stayed in the column (Argus2/Gabriela saved 33,
-- sent at 100 since 2026-09-29). Clear the expiry and keep the saved value.
UPDATE whatsapp_accounts
   SET outreach_volume_until = NULL
 WHERE outreach_volume_until IS NOT NULL AND outreach_volume_until <= NOW();

UPDATE whatsapp_accounts
   SET outreach_pace_min = COALESCE(outreach_pace_min, outreach_volume_percent, 100),
       outreach_pace_max = COALESCE(outreach_pace_max, outreach_volume_percent, 100)
 WHERE outreach_pace_min IS NULL OR outreach_pace_max IS NULL;

DO $$ BEGIN
  ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_outreach_pace_range
    CHECK (outreach_pace_min IS NULL OR (outreach_pace_min BETWEEN 10 AND 100
           AND outreach_pace_max BETWEEN 10 AND 100 AND outreach_pace_min <= outreach_pace_max));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_outreach_daily_target
    CHECK (outreach_daily_target_min BETWEEN 1 AND 40 AND outreach_daily_target_max BETWEEN 1 AND 40
           AND outreach_daily_target_min <= outreach_daily_target_max);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Plans remember whether their text is free text or a persona-library slot
--    rendered at send time.
ALTER TABLE outreach_plans
  ADD COLUMN IF NOT EXISTS message_mode TEXT NOT NULL DEFAULT 'free_text',
  ADD COLUMN IF NOT EXISTS template_slot INTEGER,
  ADD COLUMN IF NOT EXISTS saved_all_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE outreach_plans ADD CONSTRAINT outreach_plans_message_mode
    CHECK (message_mode IN ('free_text', 'persona_rotation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Persona template library (editable in the CRM, seeded below) and the
--    per-account rotation history.
CREATE TABLE IF NOT EXISTS outreach_persona_templates (
  id SERIAL PRIMARY KEY,
  persona TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('morning', 'afternoon', 'evening')),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 12),
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 20 AND 1200),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (persona, period, slot)
);

CREATE TABLE IF NOT EXISTS outreach_template_usage (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  slot INTEGER NOT NULL,
  plan_id INTEGER UNIQUE REFERENCES outreach_plans(id) ON DELETE SET NULL,
  used_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outreach_template_usage_account
  ON outreach_template_usage(account_id, used_on DESC, id DESC);

-- 4. Hard daily cap: max 40 unique recipients per account per Malta day.
CREATE TABLE IF NOT EXISTS outreach_daily_quota (
  account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  malta_date DATE NOT NULL,
  target INTEGER NOT NULL CHECK (target BETWEEN 1 AND 40),
  cap INTEGER NOT NULL DEFAULT 40 CHECK (cap BETWEEN 1 AND 40),
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, malta_date),
  CHECK (used >= 0 AND used <= cap)
);

CREATE TABLE IF NOT EXISTS outreach_daily_recipients (
  account_id INTEGER NOT NULL,
  malta_date DATE NOT NULL,
  phone TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'sent')),
  run_id TEXT,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, malta_date, phone),
  FOREIGN KEY (account_id, malta_date) REFERENCES outreach_daily_quota(account_id, malta_date) ON DELETE CASCADE
);

-- 5. Operator-editable thresholds (engagement / call candidates).
CREATE TABLE IF NOT EXISTS outreach_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO outreach_settings(key, value) VALUES
  ('engagement.no_reply_review_after', '5'::jsonb),
  ('engagement.call_candidate_min_attempts', '3'::jsonb),
  ('engagement.report_thresholds', '[1,3,5,6,7]'::jsonb),
  ('dispatch.cross_account_days', '20'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Seed: 36 persona templates (services/outreachTemplateSeed.js). Existing
-- rows are never overwritten, so CRM edits survive re-running this file.
`

const seed = seedRows().map(r =>
  `INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES (${q(r.persona)}, ${q(r.period)}, ${r.slot}, ${q(r.body)}, 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;`
).join('\n')

const DOWN = `-- Reverse of 20261029_outreach_automation.sql. Drops the new tables/columns.
-- The data repair (expired overrides cleared) is intentionally not reversed:
-- it only removed an expiry that silently turned a saved pace into 100.
BEGIN;
DROP TABLE IF EXISTS outreach_daily_recipients;
DROP TABLE IF EXISTS outreach_daily_quota;
DROP TABLE IF EXISTS outreach_template_usage;
DROP TABLE IF EXISTS outreach_persona_templates;
DROP TABLE IF EXISTS outreach_settings;
ALTER TABLE outreach_plans DROP CONSTRAINT IF EXISTS outreach_plans_message_mode;
ALTER TABLE outreach_plans DROP COLUMN IF EXISTS message_mode, DROP COLUMN IF EXISTS template_slot, DROP COLUMN IF EXISTS saved_all_at;
ALTER TABLE whatsapp_accounts DROP CONSTRAINT IF EXISTS whatsapp_accounts_outreach_pace_range;
ALTER TABLE whatsapp_accounts DROP CONSTRAINT IF EXISTS whatsapp_accounts_outreach_daily_target;
ALTER TABLE whatsapp_accounts
  DROP COLUMN IF EXISTS outreach_pace_min, DROP COLUMN IF EXISTS outreach_pace_max,
  DROP COLUMN IF EXISTS outreach_auto_enabled, DROP COLUMN IF EXISTS outreach_auto_rolling,
  DROP COLUMN IF EXISTS outreach_auto_horizon_days, DROP COLUMN IF EXISTS outreach_daily_target_min,
  DROP COLUMN IF EXISTS outreach_daily_target_max, DROP COLUMN IF EXISTS outreach_auto_updated_at;
COMMIT;
`

const dir = path.join(__dirname, '..', 'migrations')
fs.writeFileSync(path.join(dir, '20261029_outreach_automation.sql'), `${UP}${seed}\n\nCOMMIT;\n`)
fs.writeFileSync(path.join(dir, '20261029_outreach_automation.down.sql'), DOWN)
console.log(`wrote migration with ${seedRows().length} seed templates`)
