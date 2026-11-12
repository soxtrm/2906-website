-- ============================================================================
-- 20261112_reliability_p0.sql — ARGUS operational reliability (2026-11-12)
-- ADDITIVE ONLY: two new tables. No existing table, column or row is changed.
-- ============================================================================
BEGIN;

-- 1. One row per divider-terminated upload package. The divider message is the
--    identity, so a redelivered webhook or a restart can never import twice.
CREATE TABLE IF NOT EXISTS upload_packages (
  id                    BIGSERIAL PRIMARY KEY,
  chat_id               TEXT NOT NULL,
  session               TEXT,
  divider_message_id    TEXT NOT NULL,
  divider_stanza_id     TEXT NOT NULL,
  divider_ts            BIGINT NOT NULL,
  sender_jid            TEXT NOT NULL,
  uploader_phone        TEXT,
  agent_id              INTEGER REFERENCES agents(id),
  state                 TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (state IN ('RECEIVED','PROCESSING','IMPORTED','REVIEW_REQUIRED','FAILED','DUPLICATE')),
  media_expected        INTEGER NOT NULL DEFAULT 0,
  media_imported        INTEGER,
  text_chars            INTEGER NOT NULL DEFAULT 0,
  first_message_ts      BIGINT,
  summary               TEXT,
  property_ids          INTEGER[] NOT NULL DEFAULT '{}',
  property_refs         TEXT[] NOT NULL DEFAULT '{}',
  failure_reason        TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, divider_stanza_id)
);
CREATE INDEX IF NOT EXISTS upload_packages_state_idx ON upload_packages (state, updated_at);

-- 2. Last execution of every recurring worker. Written by the worker itself.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  name             TEXT PRIMARY KEY,
  schedule         TEXT,
  last_run_at      TIMESTAMPTZ,
  last_ok_at       TIMESTAMPTZ,
  last_status      TEXT,
  last_detail      JSONB,
  runs             BIGINT NOT NULL DEFAULT 0,
  failures         BIGINT NOT NULL DEFAULT 0,
  next_expected_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
