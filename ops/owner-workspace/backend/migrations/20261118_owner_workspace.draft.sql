-- ARGUS Owner Workspace — DRAFT schema (2026-11-18). NOT APPLIED.
-- Extends the existing model; no second property, owner or booking engine.
--   properties            stays the canonical physical property (id, ref)
--   owner_contacts        stays the owner identity
--   nexus_owner_links     stays invitation / claim / verification (contract 2026-11-11.v1)
--   property_viewings     stays THE booking table (GiST overlap exclusion already there)
--   property_viewing_windows stays the viewing-hours table
-- Apply only after the security gate (see SECURITY.md) and with the backup-v2 gate.

BEGIN;

-- 1. Owner sign-in: a real session, never a link. One account can hold several
--    owner_contacts (same person, several numbers) and delegates.
CREATE TABLE IF NOT EXISTS owner_accounts (
  id            BIGSERIAL PRIMARY KEY,
  agency_key    TEXT NOT NULL DEFAULT '2906',            -- tenancy: 2906 and Benestates never share rows
  display_name  TEXT NOT NULL,
  email         TEXT,
  phone_normalized TEXT,
  password_hash TEXT,                                    -- or passkey; set via one-time link (agent_password_resets pattern)
  status        TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','locked','closed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agency_key, email)
);
CREATE TABLE IF NOT EXISTS owner_account_members (      -- who may act for which owner identity
  owner_account_id BIGINT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
  owner_contact_id INTEGER NOT NULL REFERENCES owner_contacts(id),
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','viewer')),
  property_ids  INTEGER[],                               -- NULL = every verified property of that owner
  granted_by    TEXT NOT NULL,                           -- 'nexus_link_verification:<link id>' | 'owner:<account id>' | 'admin:<agent id>'
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  PRIMARY KEY (owner_account_id, owner_contact_id)
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id BIGINT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,                    -- only the hash is stored
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            INET,
  user_agent    TEXT
);

-- 2. Rooms / units with stable ids inside one property.
CREATE TABLE IF NOT EXISTS property_rooms (
  id            BIGSERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id),
  room_no       INTEGER NOT NULL,
  label         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','reserved','inactive')),
  monthly_price NUMERIC(10,2),
  size_sqm      NUMERIC(6,1),
  ensuite       BOOLEAN NOT NULL DEFAULT FALSE,
  available_from DATE,
  occupied_until DATE,
  zone          JSONB,                                   -- {x,y,w,h} in plan metres (spatial-studio plan coordinates)
  photos        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, room_no)
);
CREATE TABLE IF NOT EXISTS property_floor_plans (
  property_id   INTEGER PRIMARY KEY REFERENCES properties(id),
  plan          JSONB NOT NULL,                          -- {width,depth,shared[],doors[],windows[]}
  source        TEXT NOT NULL CHECK (source IN ('owner_drawn','scan','spatial_studio','agent')),
  accuracy      TEXT NOT NULL DEFAULT 'ILLUSTRATIVE',
  updated_by    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Operating mode + offers: modes are offers of the same property, with history.
CREATE TABLE IF NOT EXISTS property_offers (
  id            BIGSERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id),
  mode          TEXT NOT NULL CHECK (mode IN ('long_let','rooms','shortlet','sale','commercial')),
  price         NUMERIC(12,2),
  period        TEXT NOT NULL CHECK (period IN ('month','night','total')),
  active        BOOLEAN NOT NULL DEFAULT FALSE,
  hide_price_for TEXT[] NOT NULL DEFAULT '{}',           -- 'agencies' | 'public' | 'nexus'
  valid_from    DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to      DATE,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS property_offers_one_active ON property_offers(property_id) WHERE active;
-- properties.longlet_price / sale_price / rental_modes stay and are written from the active offer (no reader breaks).

-- 4. Agencies (today agency_key is free text) and owner distribution.
CREATE TABLE IF NOT EXISTS agencies (
  id            BIGSERIAL PRIMARY KEY,
  agency_key    TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended'))
);
CREATE TABLE IF NOT EXISTS owner_distribution_defaults (
  owner_account_id BIGINT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
  settings      JSONB NOT NULL,                          -- {nexusDirect,argusB2B,allApprovedAgencies,agencyIds,agentIds,private}
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS property_distribution_settings (
  property_id   INTEGER PRIMARY KEY REFERENCES properties(id),
  inherit       BOOLEAN NOT NULL DEFAULT TRUE,
  settings      JSONB,                                   -- same shape as the defaults
  exclusive_agency_id BIGINT REFERENCES agencies(id),
  exclusive_until DATE,
  exclusive_then TEXT CHECK (exclusive_then IN ('all_approved','selected','private')),
  updated_by    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Effective recipients are materialised into the EXISTING nexus_distribution_grants /
-- nexus_distribution_routes and delivered through nexus_sync_outbox (distribution.released /
-- distribution.release_revoked). Revocation = route 'revoked' + outbox event; the owner UI
-- reads delivery state back from there ("being removed" until acknowledged).

-- 5. Viewing requests: extend the one booking table instead of a new engine.
ALTER TABLE property_viewings
  ADD COLUMN IF NOT EXISTS room_id BIGINT REFERENCES property_rooms(id),
  ADD COLUMN IF NOT EXISTS request_state TEXT CHECK (request_state IN
      ('awaiting_owner','question','new_time_proposed','confirmed','declined','cancelled','completed')),
  ADD COLUMN IF NOT EXISTS request_source TEXT CHECK (request_source IN
      ('argus_crm','agency_board','nexus_housing','direct_listing','booking_link','facebook_link','whatsapp')),
  ADD COLUMN IF NOT EXISTS requester_agency_id BIGINT REFERENCES agencies(id),
  ADD COLUMN IF NOT EXISTS client_ref TEXT,
  ADD COLUMN IF NOT EXISTS applicant JSONB,               -- {adults,children,moveIn,months,pets,working}; never nationality
  ADD COLUMN IF NOT EXISTS proposed_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS contact_access_state TEXT NOT NULL DEFAULT 'none'
      CHECK (contact_access_state IN ('none','requested','approved','denied'));
CREATE UNIQUE INDEX IF NOT EXISTS property_viewings_idem ON property_viewings(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- room-level overlap: whole-property viewings keep the existing GiST exclusion; room viewings
-- are checked by the service (engine.ts confirmedClash) inside the same transaction.
CREATE TABLE IF NOT EXISTS property_viewing_events (     -- audit trail with a real actor
  id            BIGSERIAL PRIMARY KEY,
  viewing_id    INTEGER NOT NULL REFERENCES property_viewings(id),
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','tenant','argus','admin')),
  actor_id      TEXT,
  action        TEXT NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Walkie-talkie: one conversation table, messages relayed and masked by bookRelay rules.
CREATE TABLE IF NOT EXISTS owner_threads (
  id            BIGSERIAL PRIMARY KEY,
  owner_account_id BIGINT NOT NULL REFERENCES owner_accounts(id),
  property_id   INTEGER REFERENCES properties(id),
  viewing_id    INTEGER REFERENCES property_viewings(id),
  counterpart   TEXT NOT NULL,                           -- 'argus_main' | 'agency:<id>' | 'tenant:<client_ref>'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS owner_thread_messages (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL REFERENCES owner_threads(id),
  sender        TEXT NOT NULL CHECK (sender IN ('owner','argus','agent','tenant')),
  body_masked   TEXT NOT NULL,                           -- after scrubForOwner / maskPhonesForDisplay
  actions       JSONB,
  channel       TEXT NOT NULL DEFAULT 'workspace' CHECK (channel IN ('workspace','whatsapp','email')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at       TIMESTAMPTZ
);

ROLLBACK; -- draft: replace with COMMIT only in the reviewed release
