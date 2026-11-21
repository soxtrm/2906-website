BEGIN;
UPDATE outreach_plans SET message_mode='free_text' WHERE message_mode='library';
ALTER TABLE outreach_plans DROP CONSTRAINT IF EXISTS outreach_plans_message_mode;
ALTER TABLE outreach_plans ADD CONSTRAINT outreach_plans_message_mode CHECK (message_mode = ANY (ARRAY['free_text','persona_rotation']));
ALTER TABLE outreach_plans DROP COLUMN IF EXISTS batch_min, DROP COLUMN IF EXISTS batch_max, DROP COLUMN IF EXISTS hold_reason, DROP COLUMN IF EXISTS hold_at;
DROP TABLE IF EXISTS outreach_library_usage;
DROP TABLE IF EXISTS outreach_library_templates;
COMMIT;
