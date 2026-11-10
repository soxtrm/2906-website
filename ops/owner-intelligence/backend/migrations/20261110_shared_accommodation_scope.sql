BEGIN;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS occupancy_state TEXT,
  ADD COLUMN IF NOT EXISTS whole_property_available BOOLEAN,
  ADD COLUMN IF NOT EXISTS available_place_count INTEGER,
  ADD COLUMN IF NOT EXISTS available_room_count INTEGER,
  ADD COLUMN IF NOT EXISTS occupied_person_count INTEGER,
  ADD COLUMN IF NOT EXISTS whole_property_total_rent NUMERIC,
  ADD COLUMN IF NOT EXISTS viewing_invited BOOLEAN NOT NULL DEFAULT FALSE;

-- The existing sourced-fact writer already records this discriminator.  The
-- original conversation-recovery migration added the surrounding provenance
-- columns but omitted source_type, so a fresh/live rollout must repair that
-- schema gap before the shared-place facts are committed.
ALTER TABLE conversation_facts
  ADD COLUMN IF NOT EXISTS source_type TEXT;

ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_available_place_count_nonnegative,
  ADD CONSTRAINT properties_available_place_count_nonnegative
    CHECK (available_place_count IS NULL OR available_place_count >= 0),
  DROP CONSTRAINT IF EXISTS properties_available_room_count_nonnegative,
  ADD CONSTRAINT properties_available_room_count_nonnegative
    CHECK (available_room_count IS NULL OR available_room_count >= 0),
  DROP CONSTRAINT IF EXISTS properties_occupied_person_count_nonnegative,
  ADD CONSTRAINT properties_occupied_person_count_nonnegative
    CHECK (occupied_person_count IS NULL OR occupied_person_count >= 0);

CREATE INDEX IF NOT EXISTS properties_shared_offer_review_idx
  ON properties (operational_status, available_place_count)
  WHERE available_place_count > 0 OR available_room_count > 0;

COMMIT;
