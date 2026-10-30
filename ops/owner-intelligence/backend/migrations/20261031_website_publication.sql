-- 2026-10-31 CRM → 2906.estate publication state (Kev).
--
-- Evidence (production, read-only, 2026-10-31): 175 listings were shown on
-- 2906.estate as AVAILABLE while the CRM said rented (92), archived (45),
-- not_available (20), pending_check (10) or upcoming (8); 42 website prices
-- differed from the CRM. Cause: services/websiteSync.js was only called from
-- the CRM edit routes, never from the many other paths that change a listing
-- (owner says rented, board check-out, rentedDetector, ownerFactEngine …).
--
-- Fix: every relevant change to a property raises desired_revision here (a
-- trigger, so no code path can be missed); services/websitePublication.js
-- publishes from the CURRENT CRM row and records what it published.
-- Idempotent; reverse with 20261031_website_publication.down.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS website_publication_state (
  property_id        INTEGER PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  desired_revision   BIGINT NOT NULL DEFAULT 1,
  published_revision BIGINT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'sync_pending'
                     CHECK (status IN ('draft','not_ready','sync_pending','published','marked_unavailable','unpublished','failed')),
  website_status     TEXT,            -- what the public row says: available / rented / NULL
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error         TEXT,
  last_reason        TEXT,
  last_published_at  TIMESTAMPTZ,
  last_attempt_at    TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS website_publication_state_due
  ON website_publication_state(next_attempt_at)
  WHERE desired_revision > published_revision AND status <> 'failed';

-- Raise the desired revision on every change the public page depends on.
CREATE OR REPLACE FUNCTION website_publication_touch() RETURNS trigger AS $$
BEGIN
  INSERT INTO website_publication_state (property_id, desired_revision, status, next_attempt_at, attempts, updated_at)
  VALUES (NEW.id, 1, 'sync_pending', NOW(), 0, NOW())
  ON CONFLICT (property_id) DO UPDATE
    SET desired_revision = website_publication_state.desired_revision + 1,
        status = 'sync_pending',
        attempts = 0, next_attempt_at = NOW(), updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS properties_website_publication ON properties;
CREATE TRIGGER properties_website_publication
  AFTER INSERT OR UPDATE OF available_status, published, website_manually_hidden, longlet_price, sale_price,
    public_payload, description, image_ranking, bedrooms, bathrooms, town, sub_location, available_date,
    available_until, rental_modes, lease_type, shortlet, property_type, size_sqm, locality_id, feature_tags, ref, is_staging
  ON properties
  FOR EACH ROW EXECUTE FUNCTION website_publication_touch();

COMMIT;
