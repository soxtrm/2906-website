-- Down migration for 20261112_nexus_owner_updates.sql. Run before 20261111_nexus_owner_link.down.sql.
BEGIN;
DROP TABLE IF EXISTS nexus_owner_answers;
DROP TABLE IF EXISTS nexus_owner_viewing_schedules;
DROP TABLE IF EXISTS nexus_owner_property_updates;
DROP INDEX IF EXISTS nexus_inbound_events_subject_idx;
ALTER TABLE IF EXISTS nexus_inbound_events DROP COLUMN IF EXISTS subject_key;
ALTER TABLE IF EXISTS nexus_inbound_events DROP COLUMN IF EXISTS occurred_at;
COMMIT;
