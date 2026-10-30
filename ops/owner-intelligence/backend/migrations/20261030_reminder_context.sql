-- 2026-10-30 Owner reminders from conversations keep their context (Kev).
-- Minimal, compatible extension of the existing `reminders` table; every
-- column is nullable, existing rows and readers are unaffected.
-- Reverse with 20261030_reminder_context.down.sql.
--   due_precision      day | week | month | part_of_month | fallback_7_days —
--                      "January" is a month, not an owner commitment to 1 Jan
--   due_window_end     last day of that window (e.g. 2027-01-31)
--   property_id        the owner's listing when there is exactly one
--   reason             why the reminder exists ("Owner said: in January")
--   availability_state contact_later | possibly_available |
--                      awaiting_tenant_decision | available_now |
--                      available_from_date | unavailable | unknown
BEGIN;
ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS due_precision      TEXT,
  ADD COLUMN IF NOT EXISTS due_window_end     DATE,
  ADD COLUMN IF NOT EXISTS property_id        INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason             TEXT,
  ADD COLUMN IF NOT EXISTS availability_state TEXT;
CREATE INDEX IF NOT EXISTS reminders_source_message ON reminders(owner_phone, source_message_id) WHERE source_message_id IS NOT NULL;
COMMIT;
