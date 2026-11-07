BEGIN;
DELETE FROM outreach_settings WHERE updated_by='migration-20261107' AND key IN (
  'ai_reply.delay_min_seconds','ai_reply.delay_max_seconds','schedule.daily_offset_minutes',
  'schedule.window_start','schedule.window_end','schedule.timezone');
ALTER TABLE owner_auto_conversations DROP COLUMN IF EXISTS pending_source_message_id;
ALTER TABLE owner_auto_conversations DROP COLUMN IF EXISTS scheduled_response_at;
DROP TABLE IF EXISTS owner_privacy_requests;
DROP TABLE IF EXISTS global_contact_suppressions;
COMMIT;
