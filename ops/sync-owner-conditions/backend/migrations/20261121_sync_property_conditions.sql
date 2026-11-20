-- NEXUS SYNC owner conditions per property, first part of the Property Passport (Claude, 2026-11-21).
-- Additive only: one new table, no change to existing rows.
BEGIN;
CREATE TABLE IF NOT EXISTS nexus_property_conditions (
  id BIGSERIAL PRIMARY KEY,
  agency_key TEXT NOT NULL,
  property_id INT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  condition_key TEXT NOT NULL CHECK (condition_key IN ('pets_cats','pets_dogs','pets_other','tenancy_duration','occupancy','smoking','viewing','other')),
  status TEXT NOT NULL CHECK (status IN ('allowed','not_allowed','conditional','unknown')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  source TEXT NOT NULL CHECK (source IN ('owner','ai','agent')),
  state TEXT NOT NULL CHECK (state IN ('confirmed','proposed','rejected','superseded')),
  version INT NOT NULL DEFAULT 1 CHECK (version > 0),
  account_id BIGINT REFERENCES sync_accounts(id) ON DELETE SET NULL,
  owner_link_id BIGINT REFERENCES nexus_owner_links(id) ON DELETE SET NULL,
  evidence JSONB,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS nexus_property_conditions_one_confirmed ON nexus_property_conditions (agency_key, property_id, condition_key) WHERE state = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS nexus_property_conditions_one_proposal ON nexus_property_conditions (agency_key, property_id, condition_key) WHERE state = 'proposed';
CREATE INDEX IF NOT EXISTS nexus_property_conditions_property ON nexus_property_conditions (agency_key, property_id);
COMMIT;
