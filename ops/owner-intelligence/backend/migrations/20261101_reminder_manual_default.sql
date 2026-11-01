-- 2026-11-01 (Kev): reminders created from owner messages need manual approval
-- before any automated send. ALREADY APPLIED in production on 2026-11-01 03:10
-- Malta together with pausing the backlog (backup ops_backup_reminder_pause_20261101);
-- this file records it and is idempotent. Reverse: .down.sql.
BEGIN;
ALTER TABLE reminders ALTER COLUMN auto_send_status SET DEFAULT 'manual_approval';
ALTER TABLE reminders ALTER COLUMN auto_send_enabled SET DEFAULT FALSE;
COMMIT;
