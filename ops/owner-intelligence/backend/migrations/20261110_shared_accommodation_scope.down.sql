BEGIN;
DROP INDEX IF EXISTS properties_shared_offer_review_idx;
ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_available_place_count_nonnegative,
  DROP CONSTRAINT IF EXISTS properties_available_room_count_nonnegative,
  DROP CONSTRAINT IF EXISTS properties_occupied_person_count_nonnegative,
  DROP COLUMN IF EXISTS viewing_invited,
  DROP COLUMN IF EXISTS whole_property_total_rent,
  DROP COLUMN IF EXISTS occupied_person_count,
  DROP COLUMN IF EXISTS available_room_count,
  DROP COLUMN IF EXISTS available_place_count,
  DROP COLUMN IF EXISTS whole_property_available,
  DROP COLUMN IF EXISTS occupancy_state;
COMMIT;
