-- 2026-10-31 Scorecard fields (Kev). Everything else the brief asks for already
-- exists (rental_modes, available_date + field_provenance, street/locality,
-- parking_available, subletting_allowed/considered). Only the floor and the
-- kind of parking were missing. Idempotent; reverse with the .down.sql.
BEGIN;
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS floor_level  TEXT,   -- ground | 1..n | top | penthouse | basement
  ADD COLUMN IF NOT EXISTS parking_type TEXT;   -- garage | parking_space | carport
COMMIT;
