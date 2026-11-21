-- Staff-side owner documents go to private storage (Claude, 2026-11-21). Additive.
-- storeStaffDocument() registers a scanned, privately stored file here and returns 'sync-private:<key>'; the
-- existing INSERTs of the CRM / WhatsApp workflows write that value as url and this trigger completes the row.
-- A url 'sync-private:...' without a registered file is refused, so no row can point at nothing.
BEGIN;
CREATE TABLE IF NOT EXISTS owner_document_staging (
  storage_key TEXT PRIMARY KEY,
  mime TEXT,
  size_bytes INT,
  sha256 TEXT,
  scan_state TEXT NOT NULL CHECK (scan_state IN ('pending','clean')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION owner_documents_private_link() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE s owner_document_staging%ROWTYPE;
BEGIN
  IF NEW.url LIKE 'sync-private:%' AND COALESCE(NEW.storage, 'cloudinary') = 'cloudinary' THEN
    SELECT * INTO s FROM owner_document_staging WHERE storage_key = substr(NEW.url, 14);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'private document file % is not registered', substr(NEW.url, 14);
    END IF;
    NEW.storage := 'sync_private';
    NEW.storage_key := s.storage_key;
    NEW.mime := s.mime;
    NEW.size_bytes := s.size_bytes;
    NEW.sha256 := s.sha256;
    NEW.scan_state := s.scan_state;
    NEW.visibility := COALESCE(NEW.visibility, 'agency');
    DELETE FROM owner_document_staging WHERE storage_key = s.storage_key;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS owner_documents_private_link ON owner_documents;
CREATE TRIGGER owner_documents_private_link BEFORE INSERT ON owner_documents FOR EACH ROW EXECUTE FUNCTION owner_documents_private_link();
COMMIT;
