-- 2026-10-31 Owner ↔ agent attribution (Kev). Idempotent; reverse with
-- 20261031_owner_attribution.down.sql.
--   owner_contacts.assigned_*   the explicitly designated current handler —
--                               written only by an audited assignment
--   owner_assignment_events     audit trail of every (re)assignment
--   owner_chat_events           'new_owner_chat' whenever an account starts a
--                               conversation with an owner (trigger on the
--                               canonical owner_account_labels insert, so no
--                               sending path can skip it)
BEGIN;

ALTER TABLE owner_contacts
  ADD COLUMN IF NOT EXISTS assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_session  TEXT,
  ADD COLUMN IF NOT EXISTS assigned_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_by       TEXT;

CREATE TABLE IF NOT EXISTS owner_assignment_events (
  id             BIGSERIAL PRIMARY KEY,
  contact_id     INTEGER NOT NULL REFERENCES owner_contacts(id) ON DELETE CASCADE,
  from_agent_id  INTEGER, from_session TEXT,
  to_agent_id    INTEGER, to_session   TEXT,
  reason         TEXT,
  actor_agent_id INTEGER, actor_name   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_assignment_events_contact ON owner_assignment_events(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS owner_chat_events (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES owner_contacts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  account     TEXT,
  source      TEXT,
  property_id INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_chat_events_contact ON owner_chat_events(contact_id, created_at DESC);

CREATE OR REPLACE FUNCTION owner_chat_started() RETURNS trigger AS $$
BEGIN
  INSERT INTO owner_chat_events (contact_id, kind, account, source, created_at)
  VALUES (NEW.contact_id, 'new_owner_chat', NEW.account_session, NEW.source, COALESCE(NEW.created_at, NOW()));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS owner_account_labels_chat_started ON owner_account_labels;
CREATE TRIGGER owner_account_labels_chat_started
  AFTER INSERT ON owner_account_labels FOR EACH ROW EXECUTE FUNCTION owner_chat_started();

COMMIT;
