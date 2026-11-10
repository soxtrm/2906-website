-- Rollback for 20261110_outreach_p0.sql: removes the P0 draft variants (only
-- while still drafts) and the manual-pause columns. Live templates untouched.
BEGIN;
DELETE FROM outreach_persona_templates WHERE slot IN (6, 7) AND updated_by = 'outreach-p0-20261110' AND status = 'draft';
ALTER TABLE outreach_automation_configs DROP COLUMN IF EXISTS manual_paused_at, DROP COLUMN IF EXISTS manual_paused_by, DROP COLUMN IF EXISTS manual_pause_reason;
UPDATE whatsapp_accounts SET outreach_daily_target_min=1, outreach_daily_target_max=GREATEST(1, outreach_daily_target_max) WHERE outreach_daily_target_min = 0 OR outreach_daily_target_max = 0;
ALTER TABLE whatsapp_accounts DROP CONSTRAINT IF EXISTS whatsapp_accounts_outreach_daily_target;
ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_outreach_daily_target
  CHECK (outreach_daily_target_min BETWEEN 1 AND 40 AND outreach_daily_target_max BETWEEN 1 AND 40 AND outreach_daily_target_min <= outreach_daily_target_max);
COMMIT;
