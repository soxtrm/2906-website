-- Rollback for 20261109_property_source_sync.sql. Refuses if any provider
-- listing was already accepted into the CRM (those properties must be reviewed
-- by a human first; nothing is deleted from properties here).
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM website_source_inventory WHERE import_status IN ('SOURCE_DRAFT','REJECTED') OR parsed_price_unit='sale') THEN
    RAISE EXCEPTION 'Provider listings were reviewed; export property_source_events and resolve them before rolling back';
  END IF;
END $$;
DROP TABLE IF EXISTS property_source_events;
DELETE FROM website_source_inventory WHERE source_id IS NOT NULL;
ALTER TABLE website_source_inventory DROP COLUMN IF EXISTS source_id, DROP COLUMN IF EXISTS source_category, DROP COLUMN IF EXISTS current_fingerprint,
  DROP COLUMN IF EXISTS current_snapshot, DROP COLUMN IF EXISTS first_seen_at, DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS missing_scan_count, DROP COLUMN IF EXISTS availability_state;
ALTER TABLE website_source_inventory DROP CONSTRAINT IF EXISTS website_source_inventory_parsed_price_unit_check;
ALTER TABLE website_source_inventory ADD CONSTRAINT website_source_inventory_parsed_price_unit_check CHECK (parsed_price_unit = ANY (ARRAY['night','week','month']));
ALTER TABLE website_source_inventory DROP CONSTRAINT IF EXISTS website_source_inventory_import_status_check;
ALTER TABLE website_source_inventory ADD CONSTRAINT website_source_inventory_import_status_check
  CHECK (import_status = ANY (ARRAY['DISCOVERED','PARSED','REVIEW_NEEDED','BASE_INVENTORY','ACTIVE','STALE','REMOVED','MERGED']));
DROP TABLE IF EXISTS property_source_scans;
DROP TABLE IF EXISTS property_sources;
COMMIT;
