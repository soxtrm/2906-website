-- ============================================================================
-- 20261111b_nexus_distribution_routes.sql — agency distribution routing
-- (Claude, 2026-11-11, queue addendum 01). ADDITIVE: one new table.
-- Requires 20261111_nexus_owner_link.sql.
--
-- An agency rule says WHEN and TO WHOM a listing may be released to other
-- agencies. It never replaces the owner's authorisation: a route without a
-- matching owner grant waits in 'awaiting_owner_authorization'.
-- No row = no external distribution. Nothing is pre-created.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS nexus_distribution_routes (
  id                    BIGSERIAL PRIMARY KEY,
  agency_key            TEXT NOT NULL DEFAULT '2906',
  property_id           INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  mode                  TEXT NOT NULL CHECK (mode IN ('immediate','delay_days','release_at','none')),
  delay_days            INTEGER CHECK (delay_days IS NULL OR (delay_days BETWEEN 1 AND 365)),
  release_at            TIMESTAMPTZ,
  audience_type         TEXT NOT NULL DEFAULT 'none'
    CHECK (audience_type IN ('none','all_eligible_agencies','selected_agencies','approved_large_agencies','independent_agents')),
  audience_refs         TEXT[] NOT NULL DEFAULT '{}',
  commercial_terms_ref  TEXT,                -- reference to an EXISTING agreement; never created here
  release_state         TEXT NOT NULL DEFAULT 'draft'
    CHECK (release_state IN ('draft','awaiting_owner_authorization','scheduled','released','revoked')),
  -- The release clock starts at the agency's explicit approval, never at a sync timestamp.
  approved_release_at   TIMESTAMPTZ,
  approved_by_agent_id  INTEGER REFERENCES agents(id),
  scheduled_release_at  TIMESTAMPTZ,
  released_at           TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  revoked_by            TEXT,                -- 'agency' | 'owner'
  revoked_reason        TEXT,
  origin_agent_id       INTEGER REFERENCES agents(id),
  created_by_agent_id   INTEGER REFERENCES agents(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nexus_distribution_routes_mode_shape CHECK (
    (mode = 'delay_days' AND delay_days IS NOT NULL) OR
    (mode = 'release_at' AND release_at IS NOT NULL) OR
    (mode IN ('immediate','none'))),
  CONSTRAINT nexus_distribution_routes_none_shape CHECK (mode <> 'none' OR audience_type = 'none'),
  CONSTRAINT nexus_distribution_routes_audience_shape CHECK (mode = 'none' OR audience_type <> 'none')
);
-- One current rule per listing; revoked rules are kept as history.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_distribution_routes_current_uniq
  ON nexus_distribution_routes (agency_key, property_id) WHERE release_state <> 'revoked';
CREATE INDEX IF NOT EXISTS nexus_distribution_routes_due_idx
  ON nexus_distribution_routes (scheduled_release_at) WHERE release_state = 'scheduled';

COMMIT;
