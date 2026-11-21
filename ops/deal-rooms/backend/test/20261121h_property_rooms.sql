-- NEXUS Rooms (2026-11-21, Kev: one apartment, several rooms, one booking logic).
-- One canonical property (properties) with child units: rentable rooms and shared spaces. Additive only.
-- Reservations do NOT live here: NEXUS Booking owns dates, holds and conflicts (room_stays).
CREATE TABLE IF NOT EXISTS property_units (
  id              BIGSERIAL PRIMARY KEY,
  property_id     INTEGER NOT NULL REFERENCES properties(id),
  kind            TEXT NOT NULL CHECK (kind IN ('room','shared')),
  position        INTEGER NOT NULL CHECK (position BETWEEN 1 AND 99),   -- stable, never reused: span [position*100, +100) in NEXUS Booking
  label           TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  shared_type     TEXT CHECK (shared_type IS NULL OR shared_type IN ('kitchen','living','bathroom','balcony','terrace','laundry','garden','other')),
  status          TEXT NOT NULL DEFAULT 'off_market' CHECK (status IN ('on_market','hold','off_market','occupied')),
  price_month     NUMERIC(10,2) CHECK (price_month IS NULL OR price_month BETWEEN 50 AND 20000),
  price_night     NUMERIC(10,2) CHECK (price_night IS NULL OR price_night BETWEEN 10 AND 2000),
  min_stay_months INTEGER CHECK (min_stay_months IS NULL OR min_stay_months BETWEEN 1 AND 36),
  max_occupants   INTEGER CHECK (max_occupants IS NULL OR max_occupants BETWEEN 1 AND 6),
  size_sqm        NUMERIC(6,1) CHECK (size_sqm IS NULL OR size_sqm BETWEEN 2 AND 200),   -- approximate unless size_verified
  size_verified   BOOLEAN NOT NULL DEFAULT false,
  private_bathroom BOOLEAN NOT NULL DEFAULT false,
  features        JSONB NOT NULL DEFAULT '[]'::jsonb,
  photos          JSONB NOT NULL DEFAULT '[]'::jsonb,
  description     TEXT CHECK (description IS NULL OR char_length(description) <= 1200),
  available_from  DATE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ,
  UNIQUE (property_id, kind, position)
);
CREATE INDEX IF NOT EXISTS property_units_property ON property_units(property_id) WHERE retired_at IS NULL;

-- Whole apartment vs room by room, with history (rows are closed, never edited or deleted).
CREATE TABLE IF NOT EXISTS property_letting_modes (
  id          BIGSERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  mode        TEXT NOT NULL CHECK (mode IN ('whole','rooms')),
  markets     TEXT[] NOT NULL DEFAULT ARRAY['long_let']::text[],
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ,
  set_by      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (markets <@ ARRAY['long_let','short_let']::text[] AND cardinality(markets) >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS property_letting_modes_current ON property_letting_modes(property_id) WHERE valid_to IS NULL;

-- The 2.5D layout: approximate room blocks the owner draws and confirms. Never verified geometry.
CREATE TABLE IF NOT EXISTS property_layouts (
  property_id  INTEGER PRIMARY KEY REFERENCES properties(id),
  layout       JSONB NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','owner_confirmed')),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','assisted')),
  floor_plan   TEXT,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
