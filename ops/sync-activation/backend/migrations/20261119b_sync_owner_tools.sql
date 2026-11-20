-- NEXUS SYNC, second step (Claude, 2026-11-19): phone login over WhatsApp,
-- owner preferences (nicknames, sharing defaults), agent assignment.
-- Additive only.
BEGIN;
ALTER TABLE sync_checks DROP CONSTRAINT IF EXISTS sync_checks_kind_check;
ALTER TABLE sync_checks ADD CONSTRAINT sync_checks_kind_check CHECK (kind IN ('email','phone_whatsapp','phone_sms','login_whatsapp'));
ALTER TABLE sync_checks ADD COLUMN IF NOT EXISTS poll_hash TEXT;
CREATE INDEX IF NOT EXISTS sync_checks_poll ON sync_checks (poll_hash) WHERE poll_hash IS NOT NULL;
ALTER TABLE sync_accounts ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sync_accounts ADD COLUMN IF NOT EXISTS assigned_agent_id INT;
COMMIT;
