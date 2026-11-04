BEGIN;

ALTER TABLE book_relay_threads
  DROP COLUMN IF EXISTS reopened_by_agent_id,
  DROP COLUMN IF EXISTS reopened_at;

DROP TRIGGER IF EXISTS book_relay_message_audit_trigger ON book_relay_messages;
DROP FUNCTION IF EXISTS enrich_book_relay_message_audit();
DROP INDEX IF EXISTS book_relay_messages_source_once;
ALTER TABLE book_relay_messages
  DROP COLUMN IF EXISTS referenced_property_ids,
  DROP COLUMN IF EXISTS agent_id,
  DROP COLUMN IF EXISTS delivery_status,
  DROP COLUMN IF EXISTS source_message_id;

ALTER TABLE conversation_facts
  DROP COLUMN IF EXISTS correction_note,
  DROP COLUMN IF EXISTS dismissed_by_agent_id,
  DROP COLUMN IF EXISTS dismissed_at,
  DROP COLUMN IF EXISTS access_scope;

DROP TABLE IF EXISTS conversation_processing_events;
DROP TABLE IF EXISTS conversation_review_tasks;

ALTER TABLE conversation_intelligence_state
  DROP COLUMN IF EXISTS automation_changed_at,
  DROP COLUMN IF EXISTS automation_changed_by_agent_id,
  DROP COLUMN IF EXISTS automation_reason,
  DROP COLUMN IF EXISTS automation_status;

COMMIT;
