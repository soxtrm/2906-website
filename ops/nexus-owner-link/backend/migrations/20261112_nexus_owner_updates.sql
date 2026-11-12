-- ============================================================================
-- 20261112_nexus_owner_updates.sql — what the owner changes in NEXUS, pushed
-- to ARGUS as signed events (Claude, 2026-11-12). ADDITIVE: three new tables
-- and two columns on a table of this feature. Requires 20261111_nexus_owner_link.sql.
--
-- Nothing here writes to `properties`. An owner's passport edit is stored as
-- the owner's statement for staff to review; existing inventory is never
-- overwritten by an event.
-- ============================================================================
BEGIN;

-- Ordering of inbound events: a late-arriving older event must not undo a newer one.
ALTER TABLE nexus_inbound_events ADD COLUMN IF NOT EXISTS subject_key TEXT;
ALTER TABLE nexus_inbound_events ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS nexus_inbound_events_subject_idx
  ON nexus_inbound_events (agency_key, subject_key, occurred_at) WHERE subject_key IS NOT NULL;

-- 1. Owner edits of the Property Passport. `fields` is the complete set of
--    owner-edited fields at that version, never a delta.
CREATE TABLE IF NOT EXISTS nexus_owner_property_updates (
  id                    BIGSERIAL PRIMARY KEY,
  agency_key            TEXT NOT NULL,
  property_id           INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  owner_link_id         BIGINT NOT NULL REFERENCES nexus_owner_links(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL CHECK (version > 0),
  fields                JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  review_state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending','accepted','rejected','superseded')),
  reviewed_by_agent_id  INTEGER REFERENCES agents(id),
  reviewed_at           TIMESTAMPTZ,
  source_event_id       TEXT NOT NULL UNIQUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nexus_owner_property_updates_version_uniq UNIQUE (agency_key, property_id, version)
);
CREATE INDEX IF NOT EXISTS nexus_owner_property_updates_pending_idx
  ON nexus_owner_property_updates (agency_key, property_id) WHERE review_state = 'pending';

-- 2. The owner's viewing preferences (one current row per listing).
CREATE TABLE IF NOT EXISTS nexus_owner_viewing_schedules (
  agency_key       TEXT NOT NULL,
  property_id      INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  owner_link_id    BIGINT NOT NULL REFERENCES nexus_owner_links(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL CHECK (version > 0),
  schedule         JSONB NOT NULL CHECK (jsonb_typeof(schedule) = 'object'),
  source_event_id  TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agency_key, property_id)
);

-- 3. Answers the owner approved for sharing (one current row per question).
CREATE TABLE IF NOT EXISTS nexus_owner_answers (
  id               BIGSERIAL PRIMARY KEY,
  agency_key       TEXT NOT NULL,
  property_id      INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  owner_link_id    BIGINT NOT NULL REFERENCES nexus_owner_links(id) ON DELETE CASCADE,
  question_key     TEXT NOT NULL,
  question         TEXT NOT NULL,
  answer           TEXT,
  version          INTEGER NOT NULL CHECK (version > 0),
  approved_at      TIMESTAMPTZ,
  withdrawn_at     TIMESTAMPTZ,
  source_event_id  TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nexus_owner_answers_question_uniq UNIQUE (agency_key, property_id, question_key)
);

COMMIT;
