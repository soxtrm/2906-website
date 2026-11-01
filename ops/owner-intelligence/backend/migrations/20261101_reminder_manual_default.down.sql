-- Reverse of 20261101_reminder_manual_default.sql (does NOT release the paused backlog).
BEGIN;
ALTER TABLE reminders ALTER COLUMN auto_send_status SET DEFAULT 'unplanned';
ALTER TABLE reminders ALTER COLUMN auto_send_enabled SET DEFAULT TRUE;
COMMIT;
