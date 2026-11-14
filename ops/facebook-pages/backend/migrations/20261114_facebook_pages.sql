-- ARGUS × Facebook Business Pages (Claude, 2026-11-14)
-- Additive only. Every table is new and prefixed agent_facebook_* — nothing here
-- touches Kevin's existing Facebook tooling (facebook_groups,
-- facebook_campaign_config, fb_*, property_publishing_status).
--
-- Secrets live ONLY in agent_facebook_credentials (AES-256-GCM ciphertext,
-- key from ARGUS_FB_TOKEN_KEY, never in the database). Every other table holds
-- references and non-sensitive metadata.
BEGIN;

CREATE TABLE IF NOT EXISTS agent_facebook_credentials (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('user', 'page')),
  ciphertext    TEXT NOT NULL,
  key_version   TEXT NOT NULL DEFAULT 'v1',
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at    TIMESTAMPTZ
);

-- One-time OAuth state (CSRF). Only the SHA-256 of the state is stored.
CREATE TABLE IF NOT EXISTS agent_facebook_oauth_states (
  state_hash    TEXT PRIMARY KEY,
  agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL DEFAULT 'connect' CHECK (purpose IN ('connect', 'reconnect')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_afb_oauth_states_agent ON agent_facebook_oauth_states (agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_facebook_connections (
  id                       BIGSERIAL PRIMARY KEY,
  agent_id                 INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  fb_user_id               TEXT NOT NULL,          -- app-scoped user id
  fb_user_name             TEXT,
  state                    TEXT NOT NULL DEFAULT 'active'
                           CHECK (state IN ('active', 'reconnect_required', 'disconnected')),
  state_reason             TEXT,
  granted_scopes           TEXT[] NOT NULL DEFAULT '{}',
  declined_scopes          TEXT[] NOT NULL DEFAULT '{}',
  user_credential_id       BIGINT REFERENCES agent_facebook_credentials(id) ON DELETE SET NULL,
  token_expires_at         TIMESTAMPTZ,
  data_access_expires_at   TIMESTAMPTZ,
  graph_version            TEXT,
  connected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at          TIMESTAMPTZ,
  disconnected_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- At most one live (non-disconnected) connection per ARGUS agent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_afb_connection_live_agent
  ON agent_facebook_connections (agent_id) WHERE state <> 'disconnected';
CREATE INDEX IF NOT EXISTS idx_afb_connection_fb_user ON agent_facebook_connections (fb_user_id);

CREATE TABLE IF NOT EXISTS agent_facebook_pages (
  id                 BIGSERIAL PRIMARY KEY,
  connection_id      BIGINT NOT NULL REFERENCES agent_facebook_connections(id) ON DELETE CASCADE,
  agent_id           INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  page_id            TEXT NOT NULL,                -- Meta Page id
  page_name          TEXT NOT NULL,
  picture_url        TEXT,
  category           TEXT,
  tasks              TEXT[] NOT NULL DEFAULT '{}',
  can_publish        BOOLEAN NOT NULL DEFAULT FALSE,   -- CREATE_CONTENT task + pages_manage_posts
  page_credential_id BIGINT REFERENCES agent_facebook_credentials(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'missing_permission', 'removed', 'disconnected')),
  status_reason      TEXT,
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,   -- publishing destination
  is_default         BOOLEAN NOT NULL DEFAULT FALSE,
  auto_publish       BOOLEAN NOT NULL DEFAULT FALSE,   -- may receive automatic publications
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, page_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_afb_page_default ON agent_facebook_pages (agent_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_afb_pages_connection ON agent_facebook_pages (connection_id);

CREATE TABLE IF NOT EXISTS agent_facebook_preferences (
  agent_id              INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  language              TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'mt', 'de')),
  default_template_id   BIGINT,
  use_emojis            BOOLEAN NOT NULL DEFAULT TRUE,
  include_contact       BOOLEAN NOT NULL DEFAULT FALSE,
  include_link          BOOLEAN NOT NULL DEFAULT TRUE,
  call_to_action        TEXT,
  auto_publish_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  auto_publish_enabled_at TIMESTAMPTZ,
  auto_daily_limit      INTEGER NOT NULL DEFAULT 3 CHECK (auto_daily_limit BETWEEN 1 AND 10),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_facebook_templates (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  language    TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'mt', 'de')),
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_afb_templates_agent ON agent_facebook_templates (agent_id);

CREATE TABLE IF NOT EXISTS agent_facebook_publications (
  id                 BIGSERIAL PRIMARY KEY,
  -- No FK to properties/agents on purpose: publication history must never block
  -- an existing CRM delete of a property or agent. The ids stay as history.
  property_id        INTEGER NOT NULL,
  property_ref       TEXT,
  agent_id           INTEGER NOT NULL,
  page_row_id        BIGINT REFERENCES agent_facebook_pages(id) ON DELETE SET NULL,
  page_id            TEXT NOT NULL,
  page_name          TEXT,
  publication_type   TEXT NOT NULL CHECK (publication_type IN ('text', 'link', 'photo', 'multi_photo')),
  state              TEXT NOT NULL DEFAULT 'queued'
                     CHECK (state IN ('draft', 'queued', 'publishing', 'reconciling', 'published',
                                      'failed', 'reconnect_required', 'removed', 'needs_review', 'cancelled')),
  trigger            TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'auto_verified', 'replacement')),
  idempotency_key    TEXT NOT NULL,
  content            JSONB NOT NULL,           -- snapshot: message, images, link, language, template
  attribution_token  TEXT NOT NULL,            -- opaque campaign id carried in the smart link
  post_id            TEXT,                     -- as returned by Meta
  permalink_url      TEXT,                     -- as returned by Meta, never constructed
  media_fbids        TEXT[] NOT NULL DEFAULT '{}',
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ,
  feed_requested_at  TIMESTAMPTZ,              -- set right before the one non-idempotent call
  last_error_kind    TEXT,
  last_error_message TEXT,                     -- plain-language, never a raw API body
  last_error_code    TEXT,
  replaces_id        BIGINT REFERENCES agent_facebook_publications(id),
  published_at       TIMESTAMPTZ,
  last_checked_at    TIMESTAMPTZ,
  removed_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_afb_publication_idem ON agent_facebook_publications (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_afb_publication_post ON agent_facebook_publications (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_afb_publications_agent ON agent_facebook_publications (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_afb_publications_property ON agent_facebook_publications (property_id, page_row_id);
CREATE INDEX IF NOT EXISTS idx_afb_publications_due ON agent_facebook_publications (next_attempt_at)
  WHERE state IN ('queued', 'reconciling');

-- Meta data-deletion requests (signed_request callback). Status lookups use the code.
CREATE TABLE IF NOT EXISTS agent_facebook_deletion_requests (
  confirmation_code TEXT PRIMARY KEY,
  fb_user_id        TEXT NOT NULL,
  connections       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('received', 'completed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

COMMIT;
