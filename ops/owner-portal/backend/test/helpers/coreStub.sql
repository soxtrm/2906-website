-- STUB of the production core tables the owner portal touches (Claude, 2026-11-16).
-- Only the columns this feature reads or writes, inferred from the repo
-- snapshots (crmScheduleBoard.js, nexus-owner-link harness, lib/crm/booking.ts).
-- NOT the production schema: re-run the suite against the production
-- schema-only dump before any deploy (see ../../README.md).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'agent',
  active BOOLEAN NOT NULL DEFAULT TRUE, feature_entitlements JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS owner_contacts (
  id SERIAL PRIMARY KEY, name TEXT, phone_normalized TEXT, email TEXT,
  owner_compliance_notes TEXT, conversation_summary TEXT, do_not_contact BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, owner_id INTEGER REFERENCES owner_contacts(id),
  listed_by_agent_id INTEGER REFERENCES agents(id),
  town TEXT, sub_location TEXT, street TEXT, property_type TEXT, bedrooms INTEGER, bathrooms INTEGER, size_sqm INTEGER,
  longlet_price NUMERIC, sale_price NUMERIC, commission_note TEXT, internal_notes TEXT,
  available_status TEXT, available_date DATE, description TEXT, feature_tags TEXT[], images JSONB DEFAULT '[]'::jsonb,
  is_staging BOOLEAN NOT NULL DEFAULT FALSE, active BOOLEAN NOT NULL DEFAULT TRUE,
  last_confirmed_available_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS property_viewings (
  id SERIAL PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  viewing_date DATE, viewing_time TEXT, starts_at TIMESTAMPTZ, duration_min INTEGER NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'pending', notes TEXT, source TEXT, requester_name TEXT,
  viewing_agent_id INTEGER REFERENCES agents(id), viewing_agent_name TEXT,
  cancelled_at TIMESTAMPTZ, cancel_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  -- Production raises 23P01 on overlapping viewings; reproduce that here.
  CONSTRAINT property_viewings_no_overlap EXCLUDE USING gist (
    property_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('pending', 'confirmed') AND starts_at IS NOT NULL)
);
CREATE OR REPLACE FUNCTION stub_viewing_ends() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.ends_at := NEW.starts_at + make_interval(mins => NEW.duration_min); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS stub_viewing_ends ON property_viewings;
CREATE TRIGGER stub_viewing_ends BEFORE INSERT OR UPDATE ON property_viewings FOR EACH ROW EXECUTE FUNCTION stub_viewing_ends();
CREATE TABLE IF NOT EXISTS property_viewing_windows (
  id SERIAL PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'window', starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, from_date DATE,
  status TEXT NOT NULL DEFAULT 'active', confirmation TEXT, source_type TEXT, evidence TEXT, reference TEXT,
  created_by INTEGER, confidence TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS agent_activity_log (
  id SERIAL PRIMARY KEY, agent_id INTEGER, action_type TEXT, target_type TEXT, target_id TEXT,
  details JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
