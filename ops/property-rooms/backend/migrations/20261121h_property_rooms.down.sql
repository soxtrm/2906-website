-- Removes the rooms tables only while they hold no rows (nothing is deleted).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM property_units) OR EXISTS (SELECT 1 FROM property_letting_modes) OR EXISTS (SELECT 1 FROM property_layouts) THEN
    RAISE EXCEPTION 'rooms data exists; keep the tables (nothing deleted)';
  END IF;
END $$;
DROP TABLE IF EXISTS property_layouts; DROP TABLE IF EXISTS property_letting_modes; DROP TABLE IF EXISTS property_units;
