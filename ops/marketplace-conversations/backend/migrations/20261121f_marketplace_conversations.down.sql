-- only for a rollback right after deploy: drops the marketplace conversation tables (their rows are lost)
BEGIN;
DROP TABLE IF EXISTS mp_viewing_requests;
DROP TABLE IF EXISTS mp_messages;
DROP TABLE IF EXISTS mp_conversations;
COMMIT;
