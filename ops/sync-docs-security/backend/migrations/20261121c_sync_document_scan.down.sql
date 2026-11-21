BEGIN;
DROP INDEX IF EXISTS owner_documents_scan_pending;
ALTER TABLE owner_documents DROP CONSTRAINT IF EXISTS owner_documents_scan_state_check;
ALTER TABLE owner_documents DROP COLUMN IF EXISTS scan_state, DROP COLUMN IF EXISTS scanned_at, DROP COLUMN IF EXISTS scan_signature, DROP COLUMN IF EXISTS legacy_url;
COMMIT;
