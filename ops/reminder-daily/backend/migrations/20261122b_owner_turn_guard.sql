-- Owner conversation recovery (Kev, 2026-11-21). Additive + one reversible data step.
BEGIN;
CREATE TABLE IF NOT EXISTS owner_reply_guard_events (
  id         BIGSERIAL PRIMARY KEY,
  session    TEXT,
  chat_id    TEXT,
  module     TEXT,
  reason     TEXT NOT NULL,
  text       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_reply_guard_events_at ON owner_reply_guard_events (created_at DESC);
-- 180-day "nothing available" pauses become the 21-day no-stock cadence (old values kept for the down step)
CREATE TABLE IF NOT EXISTS owner_pause_backup_20261122 AS
  SELECT id, owner_contact_paused_until, owner_contact_pause_note FROM owner_contacts WHERE FALSE;
INSERT INTO owner_pause_backup_20261122
  SELECT id, owner_contact_paused_until, owner_contact_pause_note FROM owner_contacts
   WHERE owner_contact_pause_note LIKE 'OWNER_SAID_NOTHING_AVAILABLE%' AND owner_contact_paused_until > CURRENT_DATE
     AND NOT EXISTS (SELECT 1 FROM owner_pause_backup_20261122 b WHERE b.id = owner_contacts.id);
UPDATE owner_contacts SET owner_contact_paused_until = GREATEST(CURRENT_DATE, COALESCE(owner_contact_paused_at::date, CURRENT_DATE) + 21)
 WHERE owner_contact_pause_note LIKE 'OWNER_SAID_NOTHING_AVAILABLE%' AND owner_contact_paused_until > COALESCE(owner_contact_paused_at::date, CURRENT_DATE) + 21;
COMMIT;
