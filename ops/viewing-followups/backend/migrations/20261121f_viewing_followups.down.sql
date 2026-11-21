BEGIN;
DROP TABLE IF EXISTS viewing_followup_events;
DROP TABLE IF EXISTS viewing_followups;
ALTER TABLE agents DROP COLUMN IF EXISTS can_view_owner_contact;
COMMIT;
