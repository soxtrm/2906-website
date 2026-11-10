-- ARGUS Property Source Sync (Claude, 2026-11-09). Additive only.
-- Registry + scan runs + review events. Listing observations reuse the
-- EXISTING website_source_inventory staging table (Base Inventory); canonical
-- properties are only written by an accepted review, through the same columns
-- routes/crmBaseInventory.js uses. No second inventory, scheduler or outbox.
BEGIN;

CREATE TABLE IF NOT EXISTS property_sources (
  id                      SERIAL PRIMARY KEY,
  agency_key              TEXT NOT NULL DEFAULT '2906',
  adapter                 TEXT NOT NULL,
  label                   TEXT NOT NULL,
  provider_name           TEXT NOT NULL,
  provider_website        TEXT,
  category                TEXT NOT NULL CHECK (category IN ('long_let','sale')),
  url                     TEXT NOT NULL UNIQUE,
  -- Rights record. Polling needs GRANTED + an evidence reference; media and
  -- prose stay link-only until separately licensed.
  read_permission         TEXT NOT NULL DEFAULT 'NOT_RECORDED' CHECK (read_permission IN ('NOT_RECORDED','GRANTED','REVOKED')),
  permission_reference    TEXT,
  permission_recorded_by  INTEGER,
  permission_recorded_at  TIMESTAMPTZ,
  media_use               TEXT NOT NULL DEFAULT 'LINK_ONLY' CHECK (media_use IN ('LINK_ONLY','LICENSED')),
  text_use                TEXT NOT NULL DEFAULT 'METADATA_ONLY' CHECK (text_use IN ('METADATA_ONLY','LICENSED')),
  preferred_mode          TEXT NOT NULL DEFAULT 'html' CHECK (preferred_mode IN ('html','feed','api')),
  import_mode             TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED' CHECK (import_mode IN ('DETECT_ONLY','REVIEW_REQUIRED')),
  sync_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  interval_hours          INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 6 AND 168),
  next_check_at           TIMESTAMPTZ,
  last_check_at           TIMESTAMPTZ,
  last_success_at         TIMESTAMPTZ,
  last_error              TEXT,
  consecutive_failures    INTEGER NOT NULL DEFAULT 0,
  etag                    TEXT,
  last_modified           TEXT,
  complete_scan_count     INTEGER NOT NULL DEFAULT 0,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_by              INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT property_sources_polling_needs_permission CHECK (NOT sync_enabled OR (read_permission = 'GRANTED' AND permission_reference IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS property_source_scans (
  id           SERIAL PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES property_sources(id),
  trigger      TEXT NOT NULL CHECK (trigger IN ('MANUAL','SCHEDULED','SNAPSHOT')),
  started_by   INTEGER,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','NOT_MODIFIED')),
  complete     BOOLEAN NOT NULL DEFAULT FALSE,
  items_seen   INTEGER,
  counts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_pss_source ON property_source_scans(source_id, started_at DESC);

-- Observation columns on the existing staging table.
ALTER TABLE website_source_inventory
  ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES property_sources(id),
  ADD COLUMN IF NOT EXISTS source_category TEXT,
  ADD COLUMN IF NOT EXISTS current_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS current_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS missing_scan_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS availability_state TEXT;
CREATE INDEX IF NOT EXISTS idx_wsi_source ON website_source_inventory(source_id) WHERE source_id IS NOT NULL;
-- Supersets of the existing checks (additive): sale prices and two review
-- outcomes for provider listings. Existing rows keep their values.
ALTER TABLE website_source_inventory DROP CONSTRAINT IF EXISTS website_source_inventory_parsed_price_unit_check;
ALTER TABLE website_source_inventory ADD CONSTRAINT website_source_inventory_parsed_price_unit_check
  CHECK (parsed_price_unit = ANY (ARRAY['night','week','month','sale']));
ALTER TABLE website_source_inventory DROP CONSTRAINT IF EXISTS website_source_inventory_import_status_check;
ALTER TABLE website_source_inventory ADD CONSTRAINT website_source_inventory_import_status_check
  CHECK (import_status = ANY (ARRAY['DISCOVERED','PARSED','REVIEW_NEEDED','BASE_INVENTORY','ACTIVE','STALE','REMOVED','MERGED','SOURCE_DRAFT','REJECTED']));

CREATE TABLE IF NOT EXISTS property_source_events (
  id                     SERIAL PRIMARY KEY,
  source_id              INTEGER NOT NULL REFERENCES property_sources(id),
  wsi_id                 INTEGER NOT NULL REFERENCES website_source_inventory(id),
  scan_id                INTEGER REFERENCES property_source_scans(id),
  event_type             TEXT NOT NULL CHECK (event_type IN ('NEW','PRICE_UPDATED','AVAILABILITY_CHANGED','MEDIA_CHANGED','DETAILS_CHANGED','MISSING_FROM_SOURCE')),
  fingerprint            TEXT NOT NULL,
  previous               JSONB,
  current                JSONB NOT NULL,
  field_changes          JSONB NOT NULL DEFAULT '{}'::jsonb,
  flags                  TEXT[] NOT NULL DEFAULT '{}',
  match_candidates       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                 TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REJECTED','LINKED','CLARIFICATION','SUPERSEDED','ACKNOWLEDGED')),
  decided_by             INTEGER,
  decided_at             TIMESTAMPTZ,
  decision_note          TEXT,
  decision_result        JSONB,
  canonical_property_id  INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wsi_id, event_type, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_pse_pending ON property_source_events(source_id, status, created_at DESC);

-- First provider registrations: DISABLED, permission not recorded. Polling
-- stays off until an admin records the provider's written permission.
INSERT INTO property_sources (adapter, label, provider_name, provider_website, category, url)
VALUES ('mynexthome', 'My Next Home · Long Let', 'My Next Home', 'https://www.mynexthome.mt/', 'long_let', 'https://www.mynexthome.mt/long-let/'),
       ('mynexthome', 'My Next Home · For Sale', 'My Next Home', 'https://www.mynexthome.mt/', 'sale', 'https://www.mynexthome.mt/for-sale/')
ON CONFLICT (url) DO NOTHING;

COMMIT;
