BEGIN;
REVOKE ALL ON owner_conversation_tasks FROM argus_history_api;
DROP TABLE IF EXISTS owner_conversation_tasks;
DROP TRIGGER IF EXISTS book_relay_thread_agency_trigger ON book_relay_threads;
DROP FUNCTION IF EXISTS inherit_relay_agency();
DROP TRIGGER IF EXISTS book_relay_message_provenance_trigger ON book_relay_messages;
DROP FUNCTION IF EXISTS classify_relay_message_provenance();
ALTER TABLE book_relay_messages
  DROP CONSTRAINT IF EXISTS book_relay_messages_sender_role_check,
  DROP COLUMN IF EXISTS attachment_metadata,
  DROP COLUMN IF EXISTS provenance_source,
  DROP COLUMN IF EXISTS is_ai,
  DROP COLUMN IF EXISTS actor_agent_id,
  DROP COLUMN IF EXISTS sender_role;
ALTER TABLE book_relay_threads ALTER COLUMN agency_id DROP DEFAULT;
ALTER TABLE properties ALTER COLUMN agency_id DROP DEFAULT;
ALTER TABLE owner_contacts ALTER COLUMN agency_id DROP DEFAULT;
ALTER TABLE agents ALTER COLUMN agency_id DROP DEFAULT;
ALTER TABLE book_relay_threads DROP COLUMN IF EXISTS agency_id;
ALTER TABLE properties DROP COLUMN IF EXISTS agency_id;
ALTER TABLE owner_contacts DROP COLUMN IF EXISTS agency_id;
ALTER TABLE agents DROP COLUMN IF EXISTS agency_id;
DROP FUNCTION IF EXISTS crm_current_agency_id();
DROP TABLE IF EXISTS crm_agencies;
DROP ROLE IF EXISTS argus_history_api;
COMMIT;
