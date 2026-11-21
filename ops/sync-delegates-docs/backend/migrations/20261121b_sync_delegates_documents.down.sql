-- Rollback right after the release only: removes representatives and the SYNC document columns.
-- Files of SYNC documents stay on disk under private-docs/ until removed by hand.
BEGIN;
DELETE FROM owner_documents WHERE storage = 'sync_private';
ALTER TABLE owner_documents DROP CONSTRAINT IF EXISTS owner_documents_visibility_check, DROP CONSTRAINT IF EXISTS owner_documents_storage_check;
DROP INDEX IF EXISTS owner_documents_storage_key;
ALTER TABLE owner_documents DROP COLUMN IF EXISTS visibility, DROP COLUMN IF EXISTS storage, DROP COLUMN IF EXISTS storage_key, DROP COLUMN IF EXISTS mime,
  DROP COLUMN IF EXISTS size_bytes, DROP COLUMN IF EXISTS sha256, DROP COLUMN IF EXISTS sync_account_id, DROP COLUMN IF EXISTS shared_at, DROP COLUMN IF EXISTS deleted_at;
DROP TABLE IF EXISTS nexus_owner_delegate_properties;
DROP TABLE IF EXISTS nexus_owner_delegates;
COMMIT;
