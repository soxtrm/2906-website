-- Reverse of 20261109_outreach_planner_v2.sql. Plan rows and their sends are
-- kept; only the V2 columns, tables and seeded templates are removed.
BEGIN;
DELETE FROM outreach_persona_templates WHERE updated_by = 'planner-v2-20261109' AND slot = 5;
UPDATE outreach_persona_templates SET active = TRUE WHERE updated_by = 'planner-v2-20261109';
ALTER TABLE outreach_persona_templates
  DROP CONSTRAINT IF EXISTS outreach_persona_templates_status,
  DROP CONSTRAINT IF EXISTS outreach_persona_templates_purpose,
  DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS purpose, DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at;
DROP TABLE IF EXISTS outreach_run_events;
DROP INDEX IF EXISTS idx_outreach_plans_automation_due;
ALTER TABLE outreach_plans
  DROP CONSTRAINT IF EXISTS outreach_plans_run_mode,
  DROP CONSTRAINT IF EXISTS outreach_plans_outcome,
  DROP COLUMN IF EXISTS run_mode, DROP COLUMN IF EXISTS sequence_index, DROP COLUMN IF EXISTS target_snapshot,
  DROP COLUMN IF EXISTS pace_snapshot, DROP COLUMN IF EXISTS preflight_at, DROP COLUMN IF EXISTS dispatch_started_at,
  DROP COLUMN IF EXISTS last_accepted_at, DROP COLUMN IF EXISTS outcome, DROP COLUMN IF EXISTS outcome_reason,
  DROP COLUMN IF EXISTS accepted_count, DROP COLUMN IF EXISTS failed_count, DROP COLUMN IF EXISTS skipped_count;
DROP TABLE IF EXISTS outreach_automation_configs;
COMMIT;
