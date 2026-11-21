-- ARGUS P0 Auto Outreach fix (Kev, 2026-11-21). Additive only.
BEGIN;
-- 1. First-contact message library: fixed texts per persona, no greeting inside.
CREATE TABLE IF NOT EXISTS outreach_library_templates (
  id          SERIAL PRIMARY KEY,
  persona     TEXT NOT NULL CHECK (persona IN ('kev','gabriela','cedric')),
  number      INTEGER NOT NULL CHECK (number BETWEEN 1 AND 500),
  body        TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 40 AND 1200),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  source      TEXT NOT NULL DEFAULT 'added',
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (persona, number)
);
CREATE TABLE IF NOT EXISTS outreach_library_usage (
  id          BIGSERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES outreach_library_templates(id) ON DELETE CASCADE,
  account_id  INTEGER REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  phone       TEXT,
  plan_id     INTEGER REFERENCES outreach_plans(id) ON DELETE SET NULL,
  greeting    TEXT,
  used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outreach_library_usage_phone ON outreach_library_usage (phone);
CREATE INDEX IF NOT EXISTS idx_outreach_library_usage_account ON outreach_library_usage (account_id, used_at DESC);

-- 2. Plans: library message mode, frozen batch envelope, explicit hold reason.
ALTER TABLE outreach_plans DROP CONSTRAINT IF EXISTS outreach_plans_message_mode;
ALTER TABLE outreach_plans ADD CONSTRAINT outreach_plans_message_mode CHECK (message_mode = ANY (ARRAY['free_text','persona_rotation','library']));
ALTER TABLE outreach_plans ADD COLUMN IF NOT EXISTS batch_min INTEGER;
ALTER TABLE outreach_plans ADD COLUMN IF NOT EXISTS batch_max INTEGER;
ALTER TABLE outreach_plans ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE outreach_plans ADD COLUMN IF NOT EXISTS hold_at TIMESTAMPTZ;
COMMIT;
