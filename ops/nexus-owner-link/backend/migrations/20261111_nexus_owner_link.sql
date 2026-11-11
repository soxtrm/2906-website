-- ============================================================================
-- 20261111_nexus_owner_link.sql — ARGUS × NEXUS owner activation, first slice
-- (Claude, 2026-11-11). ADDITIVE ONLY: 8 new tables, no existing table, column,
-- row or constraint is changed. Availability freshness keeps living in
-- properties.last_confirmed_available_at — no second timestamp is created.
--
-- Every table carries agency_key (existing convention: outreach_automation_configs,
-- property_sources). Rows of one agency are never read for another.
-- ============================================================================
BEGIN;

-- 1. One stable link per (agency, ARGUS owner). nexus_account_ref stays NULL
--    until NEXUS reports a claimed account; link_state is the identity state,
--    sync_state the transport state. They are independent on purpose.
CREATE TABLE IF NOT EXISTS nexus_owner_links (
  id                  BIGSERIAL PRIMARY KEY,
  public_id           UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  agency_key          TEXT NOT NULL DEFAULT '2906',
  owner_contact_id    INTEGER NOT NULL REFERENCES owner_contacts(id) ON DELETE RESTRICT,
  nexus_account_ref   TEXT,
  link_state          TEXT NOT NULL DEFAULT 'not_invited'
    CHECK (link_state IN ('not_invited','invited','claim_pending','verified','disputed','revoked')),
  verified_at         TIMESTAMPTZ,
  verification_method TEXT,
  verified_by_agent_id INTEGER REFERENCES agents(id),
  dispute_reason      TEXT,
  sync_state          TEXT NOT NULL DEFAULT 'never'
    CHECK (sync_state IN ('never','pending','synced','error','blocked')),
  last_sync_at        TIMESTAMPTZ,
  last_sync_attempt_at TIMESTAMPTZ,
  last_sync_error     TEXT,
  created_by_agent_id INTEGER REFERENCES agents(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nexus_owner_links_owner_uniq UNIQUE (agency_key, owner_contact_id)
);
-- One NEXUS account maps to at most one ARGUS owner per agency (no duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS nexus_owner_links_account_uniq
  ON nexus_owner_links (agency_key, nexus_account_ref) WHERE nexus_account_ref IS NOT NULL;

-- 2. Invitations. The plaintext token is never stored: token = id.nonce-HMAC,
--    recomputed server-side for "Copy invitation link"; token_hash is what a
--    presented token is compared against. Revocable, single active per link.
CREATE TABLE IF NOT EXISTS nexus_owner_invitations (
  id                  BIGSERIAL PRIMARY KEY,
  owner_link_id       BIGINT NOT NULL REFERENCES nexus_owner_links(id) ON DELETE CASCADE,
  agency_key          TEXT NOT NULL DEFAULT '2906',
  nonce               TEXT NOT NULL,
  token_hash          TEXT NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ NOT NULL,
  opened_at           TIMESTAMPTZ,
  consumed_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT,
  copy_count          INTEGER NOT NULL DEFAULT 0,
  last_copied_at      TIMESTAMPTZ,
  created_by_agent_id INTEGER REFERENCES agents(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS nexus_owner_invitations_one_active
  ON nexus_owner_invitations (owner_link_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- 3. Proposed owner↔property associations the owner confirms, corrects or
--    rejects. A phone number on file is a proposal, never proof.
CREATE TABLE IF NOT EXISTS nexus_owner_property_claims (
  id             BIGSERIAL PRIMARY KEY,
  owner_link_id  BIGINT NOT NULL REFERENCES nexus_owner_links(id) ON DELETE CASCADE,
  property_id    INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  claim_state    TEXT NOT NULL DEFAULT 'proposed'
    CHECK (claim_state IN ('proposed','confirmed','corrected','rejected','disputed')),
  owner_note     TEXT,
  decided_at     TIMESTAMPTZ,
  decided_via    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nexus_owner_property_claims_uniq UNIQUE (owner_link_id, property_id)
);

-- 4. Property ↔ NEXUS canonical identity, with INDEPENDENT status dimensions.
--    Availability / rented / stale are NOT copied here: they are read live from
--    properties.available_status + properties.last_confirmed_available_at.
CREATE TABLE IF NOT EXISTS nexus_property_links (
  id                    BIGSERIAL PRIMARY KEY,
  agency_key            TEXT NOT NULL DEFAULT '2906',
  property_id           INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  external_id           TEXT NOT NULL,              -- "<agency_key>:<ref>", stable
  canonical_property_id TEXT,                       -- assigned by NEXUS only
  transaction_type      TEXT CHECK (transaction_type IN ('rent','sale')),
  link_state            TEXT NOT NULL DEFAULT 'imported'
    CHECK (link_state IN ('imported','linked')),
  owner_review_state    TEXT NOT NULL DEFAULT 'pending'
    CHECK (owner_review_state IN ('pending','verified','rejected','disputed')),
  distribution_state    TEXT NOT NULL DEFAULT 'not_authorized'
    CHECK (distribution_state IN ('not_authorized','approved','withdrawn')),
  publication_state     TEXT NOT NULL DEFAULT 'unpublished'
    CHECK (publication_state IN ('unpublished','published','held','withdrawn')),
  sync_state            TEXT NOT NULL DEFAULT 'never'
    CHECK (sync_state IN ('never','pending','synced','error','blocked')),
  blocked_reasons       TEXT[] NOT NULL DEFAULT '{}',
  last_payload_hash     TEXT,
  last_sync_at          TIMESTAMPTZ,
  last_sync_attempt_at  TIMESTAMPTZ,
  last_sync_error       TEXT,
  provenance            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nexus_property_links_property_uniq UNIQUE (agency_key, property_id),
  CONSTRAINT nexus_property_links_external_uniq UNIQUE (agency_key, external_id)
);

-- 5. Owner-approved distribution. No row = no authorization. Nothing is ever
--    pre-granted by this migration. Rows are append + revoke, never deleted.
CREATE TABLE IF NOT EXISTS nexus_distribution_grants (
  id             BIGSERIAL PRIMARY KEY,
  agency_key     TEXT NOT NULL DEFAULT '2906',
  owner_link_id  BIGINT NOT NULL REFERENCES nexus_owner_links(id) ON DELETE CASCADE,
  property_id    INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL
    CHECK (channel IN ('origin_agency','selected_agency','approved_large_agencies','all_eligible_agencies',
                       'independent_agents','nexus_direct_from_owner','other_approved')),
  audience_ref   TEXT NOT NULL DEFAULT '',           -- e.g. agency key for selected_agency
  scopes         TEXT[] NOT NULL DEFAULT '{}',       -- e.g. listing_data, photos, viewing_schedule
  granted_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  source         TEXT NOT NULL CHECK (source IN ('nexus_owner_portal')),
  source_event_id TEXT,
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS nexus_distribution_grants_active_uniq
  ON nexus_distribution_grants (agency_key, property_id, channel, audience_ref) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS nexus_distribution_grants_property_idx ON nexus_distribution_grants (property_id);

-- 6. Outbound outbox (ARGUS → NEXUS). Idempotent per key; delivery is a
--    separate step and stays 'pending' while no NEXUS receiver is configured.
CREATE TABLE IF NOT EXISTS nexus_sync_outbox (
  id               BIGSERIAL PRIMARY KEY,
  event_id         UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  agency_key       TEXT NOT NULL DEFAULT '2906',
  aggregate_type   TEXT NOT NULL CHECK (aggregate_type IN ('owner','property')),
  aggregate_id     BIGINT NOT NULL,
  event_type       TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  payload          JSONB NOT NULL,
  payload_hash     TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','delivering','delivered','failed','dead','superseded')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error       TEXT,
  delivered_at     TIMESTAMPTZ,
  created_by_agent_id INTEGER REFERENCES agents(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS nexus_sync_outbox_due_idx ON nexus_sync_outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS nexus_sync_outbox_aggregate_idx ON nexus_sync_outbox (aggregate_type, aggregate_id);

-- 7. Inbound events (NEXUS → ARGUS), idempotent on the sender's event id.
CREATE TABLE IF NOT EXISTS nexus_inbound_events (
  event_id      TEXT PRIMARY KEY,
  agency_key    TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Structured owner availability answers. A ledger of what the owner said;
--    only an explicit availability confirmation moves
--    properties.last_confirmed_available_at (through the existing board action).
CREATE TABLE IF NOT EXISTS owner_availability_answers (
  id              BIGSERIAL PRIMARY KEY,
  agency_key      TEXT NOT NULL DEFAULT '2906',
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  owner_contact_id INTEGER REFERENCES owner_contacts(id),
  outcome         TEXT NOT NULL
    CHECK (outcome IN ('available','available_from','temporarily_held','reserved','rented','ask_later')),
  available_from  DATE,
  ask_again_at    TIMESTAMPTZ,
  source          TEXT NOT NULL CHECK (source IN ('nexus_owner_portal','agent_recorded','owner_reply')),
  source_event_id TEXT,
  counted_as_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by_agent_id INTEGER REFERENCES agents(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_availability_answers_property_idx ON owner_availability_answers (property_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS owner_availability_answers_event_uniq
  ON owner_availability_answers (source, source_event_id) WHERE source_event_id IS NOT NULL;

COMMIT;
