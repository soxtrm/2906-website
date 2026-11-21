BEGIN;
DROP TABLE IF EXISTS owner_inbox_dispositions;
DROP TABLE IF EXISTS reminder_dispatches;
DELETE FROM outreach_library_templates WHERE code IS NOT NULL;
DROP INDEX IF EXISTS idx_outreach_library_pick;
DROP INDEX IF EXISTS outreach_library_templates_code_key;
ALTER TABLE outreach_library_templates DROP CONSTRAINT IF EXISTS outreach_library_templates_review_status;
ALTER TABLE outreach_library_templates DROP COLUMN IF EXISTS code, DROP COLUMN IF EXISTS intent, DROP COLUMN IF EXISTS required_context,
  DROP COLUMN IF EXISTS review_status, DROP COLUMN IF EXISTS reviewed_by, DROP COLUMN IF EXISTS reviewed_at;
DELETE FROM settings WHERE key = 'reminder_daily_since';
COMMIT;
