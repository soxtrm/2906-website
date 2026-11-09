-- Reverse of 20261029_outreach_automation.sql. Drops the new tables/columns.
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
