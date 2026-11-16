-- ============================================================================
-- 20261116_owner_portal.sql — ARGUS Owner Portal + Owner Viewing Desk (Claude,
-- 2026-11-16). ADDITIVE ONLY: new tables, no change to existing tables.
--
-- Calendar: this migration creates NO second calendar. Time is held in
-- property_viewings (existing, with its overlap constraint) and availability is
-- materialised into property_viewing_windows (existing, source_type
-- 'owner_portal'). owner_viewing_rules stores the owner's recurring intent and
-- viewing_coordination the two-stage confirmation state of a request.
--
-- Secrets: only SHA-256 hashes of invitation, session, share and request
-- tokens are stored. A share link is never a login.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS owner_portal_accounts (
  id                   BIGSERIAL PRIMARY KEY,
  owner_id             INTEGER NOT NULL UNIQUE REFERENCES owner_contacts(id) ON DELETE CASCADE,
  state                TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','suspended','revoked')),
  identity_method      TEXT,               -- how staff confirmed who the owner is (required to invite)
  properties_confirmed_at TIMESTAMPTZ,     -- owner confirmed the property list on first sign-in
  notify_mode          TEXT NOT NULL DEFAULT 'digest_2h' CHECK (notify_mode IN ('immediate','digest_2h','daily','off')),
  urgent_separately    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_agent_id  INTEGER REFERENCES agents(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Property managers / delegates: explicit properties × explicit scopes.
CREATE TABLE IF NOT EXISTS owner_portal_delegates (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'property_manager' CHECK (role IN ('property_manager')),
  property_ids  INTEGER[] NOT NULL DEFAULT '{}',
  scopes        TEXT[] NOT NULL DEFAULT '{schedule}',
  state         TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','revoked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT owner_portal_delegates_scopes CHECK (scopes <@ ARRAY['schedule','requests','inventory','sharing']::TEXT[])
);

CREATE TABLE IF NOT EXISTS owner_portal_invitations (
  id                   BIGSERIAL PRIMARY KEY,
  account_id           BIGINT NOT NULL REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  delegate_id          BIGINT REFERENCES owner_portal_delegates(id) ON DELETE CASCADE,
  purpose              TEXT NOT NULL DEFAULT 'invite' CHECK (purpose IN ('invite','recovery','delegate')),
  token_hash           TEXT NOT NULL UNIQUE,
  expires_at           TIMESTAMPTZ NOT NULL,
  consumed_at          TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  created_by_agent_id  INTEGER REFERENCES agents(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One usable invitation per owner (and per delegate) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS owner_portal_invitations_one_active
  ON owner_portal_invitations (account_id, COALESCE(delegate_id, 0)) WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS owner_portal_sessions (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  delegate_id   BIGINT REFERENCES owner_portal_delegates(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS owner_portal_sessions_account_idx ON owner_portal_sessions (account_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS owner_portal_audit (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('owner','delegate','staff','agent','external_agent','system')),
  actor_ref    TEXT,
  action       TEXT NOT NULL,
  property_id  INTEGER,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_portal_audit_account_idx ON owner_portal_audit (account_id, created_at DESC);

-- The owner's recurring viewing rules, one row per property.
CREATE TABLE IF NOT EXISTS owner_viewing_rules (
  property_id  INTEGER PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  account_id   BIGINT NOT NULL REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  schedule     JSONB NOT NULL CHECK (jsonb_typeof(schedule) = 'object'),
  version      INTEGER NOT NULL DEFAULT 1,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Owner edits: a review queue, never written straight into properties.
CREATE TABLE IF NOT EXISTS owner_property_proposals (
  id                    BIGSERIAL PRIMARY KEY,
  property_id           INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  account_id            BIGINT NOT NULL REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  actor_kind            TEXT NOT NULL CHECK (actor_kind IN ('owner','delegate')),
  actor_ref             TEXT,
  fields                JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  review_state          TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','accepted','rejected','superseded')),
  reviewed_by_agent_id  INTEGER REFERENCES agents(id),
  reviewed_at           TIMESTAMPTZ,
  review_note           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_property_proposals_pending_idx ON owner_property_proposals (property_id) WHERE review_state = 'pending';

-- New owner-submitted properties: a draft for staff, not a listing.
CREATE TABLE IF NOT EXISTS owner_property_submissions (
  id                    BIGSERIAL PRIMARY KEY,
  account_id            BIGINT NOT NULL REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  fields                JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  review_state          TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','accepted','rejected')),
  created_property_id   INTEGER REFERENCES properties(id),
  reviewed_by_agent_id  INTEGER REFERENCES agents(id),
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Owner-uploaded photos and documents, private until staff review.
CREATE TABLE IF NOT EXISTS owner_property_media (
  id            BIGSERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  account_id    BIGINT NOT NULL REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('photo','document')),
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  bytes         BYTEA NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  visibility    TEXT NOT NULL DEFAULT 'agency' CHECK (visibility IN ('agency','shared')),
  review_state  TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','accepted','rejected','removed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_property_media_size CHECK (octet_length(bytes) <= 8388608)
);

-- Where owner-approved updates may go, and their sync state.
CREATE TABLE IF NOT EXISTS owner_distribution_settings (
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  destination   TEXT NOT NULL CHECK (destination IN ('argus_agency','partner_agencies','authorized_agents','nexus_marketplace','owner_direct')),
  owner_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  sync_state    TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (sync_state IN ('not_connected','pending_approval','connected','update_pending','synced','conflict','paused')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (property_id, destination)
);

-- Agent-facing link. Capability for a read-only, allow-listed view plus
-- structured viewing requests. Never a login, never edits.
CREATE TABLE IF NOT EXISTS owner_share_links (
  id             BIGSERIAL PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES owner_portal_accounts(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  label          TEXT,
  property_ids   INTEGER[] NOT NULL,
  allow_requests BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  views          INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two-stage viewing confirmation. viewing_id is set once time is held.
CREATE TABLE IF NOT EXISTS viewing_coordination (
  id                   BIGSERIAL PRIMARY KEY,
  property_id          INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  viewing_id           INTEGER REFERENCES property_viewings(id) ON DELETE SET NULL,
  state                TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','OWNER_SLOT_PROPOSED','AGENT_CLIENT_CONFIRMATION_PENDING','CONFIRMED','DECLINED','RESCHEDULE_REQUESTED','CANCELLED','EXPIRED','COMPLETED','NO_SHOW')),
  requester_kind       TEXT NOT NULL CHECK (requester_kind IN ('argus_agent','external_agent')),
  requester_agent_id   INTEGER REFERENCES agents(id),
  requester_name       TEXT NOT NULL,
  requester_agency     TEXT,
  requester_token_hash TEXT UNIQUE,     -- external agents act through their own request link
  share_link_id        BIGINT REFERENCES owner_share_links(id) ON DELETE SET NULL,
  client               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- requirements shown to the owner only
  preferred            JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_min         INTEGER NOT NULL DEFAULT 20 CHECK (duration_min BETWEEN 5 AND 240),
  proposed_start       TIMESTAMPTZ,
  proposed_end         TIMESTAMPTZ,
  decision_note        TEXT,
  expires_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS viewing_coordination_property_idx ON viewing_coordination (property_id, state);
-- The same agent cannot file the same open request twice for one property.
CREATE UNIQUE INDEX IF NOT EXISTS viewing_coordination_no_duplicate_open
  ON viewing_coordination (property_id, lower(requester_name), lower(COALESCE(requester_agency, '')), COALESCE(client->>'clientRef', ''))
  WHERE state IN ('REQUESTED','RESCHEDULE_REQUESTED','OWNER_SLOT_PROPOSED','AGENT_CLIENT_CONFIRMATION_PENDING');

CREATE TABLE IF NOT EXISTS viewing_coordination_events (
  id               BIGSERIAL PRIMARY KEY,
  coordination_id  BIGINT NOT NULL REFERENCES viewing_coordination(id) ON DELETE CASCADE,
  from_state       TEXT,
  to_state         TEXT NOT NULL,
  action           TEXT NOT NULL,
  actor_kind       TEXT NOT NULL,
  actor_ref        TEXT,
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Founding-owner pilot pipeline (staff only).
CREATE TABLE IF NOT EXISTS owner_pilot_states (
  owner_id             INTEGER PRIMARY KEY REFERENCES owner_contacts(id) ON DELETE CASCADE,
  state                TEXT NOT NULL CHECK (state IN ('interested','pilot_invited','onboarding','active_pilot','feedback_received')),
  note                 TEXT,
  updated_by_agent_id  INTEGER REFERENCES agents(id),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
