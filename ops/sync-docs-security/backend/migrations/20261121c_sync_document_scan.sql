-- NEXUS SYNC private documents: virus-check quarantine (Claude, 2026-11-21). Additive only.
-- scan_state: pending until ClamAV reports the file clean; only 'clean' documents can be opened or shared.
-- legacy_url keeps the old Cloudinary address of a document copied into private storage, until the
-- private copy is verified and the founder approves removing the public original.
BEGIN;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS scan_state TEXT;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS scan_signature TEXT;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS legacy_url TEXT;
ALTER TABLE owner_documents DROP CONSTRAINT IF EXISTS owner_documents_scan_state_check;
ALTER TABLE owner_documents ADD CONSTRAINT owner_documents_scan_state_check CHECK (scan_state IS NULL OR scan_state IN ('pending','clean','infected'));
CREATE INDEX IF NOT EXISTS owner_documents_scan_pending ON owner_documents (id) WHERE scan_state = 'pending' AND deleted_at IS NULL;
COMMIT;
