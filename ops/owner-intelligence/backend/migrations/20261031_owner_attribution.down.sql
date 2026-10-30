-- Reverse of 20261031_owner_attribution.sql (drops the audit history).
BEGIN;
DROP TRIGGER IF EXISTS owner_account_labels_chat_started ON owner_account_labels;
DROP FUNCTION IF EXISTS owner_chat_started();
DROP TABLE IF EXISTS owner_chat_events;
DROP TABLE IF EXISTS owner_assignment_events;
ALTER TABLE owner_contacts
  DROP COLUMN IF EXISTS assigned_by,
  DROP COLUMN IF EXISTS assigned_at,
  DROP COLUMN IF EXISTS assigned_session,
  DROP COLUMN IF EXISTS assigned_agent_id;
COMMIT;
