-- Rollback of 20261113_property_intake.sql: removes only what it added.
BEGIN;
DROP INDEX IF EXISTS properties_intake_idx;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_verification_status_chk;
ALTER TABLE properties
  DROP COLUMN IF EXISTS verification_status, DROP COLUMN IF EXISTS verification_note,
  DROP COLUMN IF EXISTS verified_by_agent_id, DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS intake_source, DROP COLUMN IF EXISTS intake_received_at,
  DROP COLUMN IF EXISTS intake_package_id, DROP COLUMN IF EXISTS intake_linked_property_id;
ALTER TABLE upload_packages DROP COLUMN IF EXISTS resolution, DROP COLUMN IF EXISTS resolved_by_agent_id, DROP COLUMN IF EXISTS resolved_at;
COMMIT;
