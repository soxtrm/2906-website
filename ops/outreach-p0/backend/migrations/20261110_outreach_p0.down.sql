-- Rollback for 20261110_outreach_p0.sql: restores the one-line templates the
-- P0 deactivated, removes the P0 variants and the manual-pause columns.
BEGIN;
UPDATE outreach_persona_templates SET status = 'approved', active = TRUE, updated_by = 'outreach-p0-rollback'
 WHERE persona IN ('kev', 'cedric', 'gabriela') AND slot BETWEEN 1 AND 4 AND updated_by = 'outreach-p0-20261110';
UPDATE outreach_persona_templates SET status = 'draft', approved_by = NULL, approved_at = NULL
 WHERE persona IN ('kev', 'cedric') AND slot = 5 AND approved_by = 'founder-brief-2026-11-10';
DELETE FROM outreach_persona_templates WHERE slot IN (6, 7) AND updated_by = 'outreach-p0-20261110';
ALTER TABLE outreach_automation_configs DROP COLUMN IF EXISTS manual_paused_at, DROP COLUMN IF EXISTS manual_paused_by, DROP COLUMN IF EXISTS manual_pause_reason;
COMMIT;
