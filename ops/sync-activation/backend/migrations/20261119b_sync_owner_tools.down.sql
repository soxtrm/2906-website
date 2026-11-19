BEGIN;
ALTER TABLE sync_accounts DROP COLUMN IF EXISTS assigned_agent_id;
ALTER TABLE sync_accounts DROP COLUMN IF EXISTS prefs;
DROP INDEX IF EXISTS sync_checks_poll;
ALTER TABLE sync_checks DROP COLUMN IF EXISTS poll_hash;
DELETE FROM sync_checks WHERE kind='login_whatsapp';
ALTER TABLE sync_checks DROP CONSTRAINT IF EXISTS sync_checks_kind_check;
ALTER TABLE sync_checks ADD CONSTRAINT sync_checks_kind_check CHECK (kind IN ('email','phone_whatsapp','phone_sms'));
COMMIT;
