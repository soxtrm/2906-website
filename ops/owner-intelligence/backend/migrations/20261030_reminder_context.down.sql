-- Reverse of 20261030_reminder_context.sql.
BEGIN;
DROP INDEX IF EXISTS reminders_source_message;
ALTER TABLE reminders
  DROP COLUMN IF EXISTS availability_state,
  DROP COLUMN IF EXISTS reason,
  DROP COLUMN IF EXISTS property_id,
  DROP COLUMN IF EXISTS due_window_end,
  DROP COLUMN IF EXISTS due_precision;
COMMIT;
