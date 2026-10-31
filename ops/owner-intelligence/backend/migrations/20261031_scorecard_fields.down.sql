-- Reverse of 20261031_scorecard_fields.sql.
BEGIN;
ALTER TABLE properties DROP COLUMN IF EXISTS parking_type, DROP COLUMN IF EXISTS floor_level;
COMMIT;
