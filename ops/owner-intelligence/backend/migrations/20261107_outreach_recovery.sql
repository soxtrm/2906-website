-- ARGUS Outreach Recovery Sprint (2026-11-07)
-- Additive, idempotent and deliberately does not arm or send anything.
BEGIN;

-- A contact-wide suppression is keyed by a one-way digest.  The original
-- phone remains only in the already protected owner record; this table keeps
-- the minimum identity required to prevent re-import/re-contact across every
-- sender account.
CREATE TABLE IF NOT EXISTS global_contact_suppressions (
  identity_hash       TEXT PRIMARY KEY CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  identity_type       TEXT NOT NULL DEFAULT 'whatsapp_phone' CHECK (identity_type='whatsapp_phone'),
  reason_code         TEXT NOT NULL,
  source              TEXT NOT NULL,
  source_message_id   TEXT,
  first_requested_at  TIMESTAMPTZ NOT NULL,
  last_requested_at   TIMESTAMPTZ NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  resolved_by         TEXT,
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS global_contact_suppressions_active_idx
  ON global_contact_suppressions(active, last_requested_at DESC);

CREATE TABLE IF NOT EXISTS owner_privacy_requests (
  id                  BIGSERIAL PRIMARY KEY,
  identity_hash       TEXT NOT NULL REFERENCES global_contact_suppressions(identity_hash) ON DELETE RESTRICT,
  owner_id            INTEGER REFERENCES owner_contacts(id) ON DELETE SET NULL,
  request_type        TEXT NOT NULL CHECK (request_type IN ('STOP_CONTACT','ERASURE','PRIVACY_COMPLAINT')),
  status              TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','IN_PROGRESS','COMPLETED','REJECTED')),
  source              TEXT NOT NULL,
  source_message_id   TEXT,
  evidence_excerpt    TEXT,
  requested_at        TIMESTAMPTZ NOT NULL,
  processed_by        TEXT,
  processed_at        TIMESTAMPTZ,
  processing_note     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_privacy_requests_source_uidx
  ON owner_privacy_requests(identity_hash, COALESCE(source_message_id,''), request_type);
CREATE INDEX IF NOT EXISTS owner_privacy_requests_status_idx
  ON owner_privacy_requests(status, requested_at DESC);

-- The scheduled timestamp is visible to agents and is reset whenever a newer
-- owner message replaces the pending reply.
ALTER TABLE owner_auto_conversations
  ADD COLUMN IF NOT EXISTS scheduled_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_source_message_id TEXT;

-- One explicit setting, not hidden timing constants. Values are seconds.
INSERT INTO outreach_settings(key,value,updated_by) VALUES
  ('ai_reply.delay_min_seconds','120'::jsonb,'migration-20261107'),
  ('ai_reply.delay_max_seconds','180'::jsonb,'migration-20261107'),
  ('schedule.daily_offset_minutes','15'::jsonb,'migration-20261107'),
  ('schedule.window_start','"08:30"'::jsonb,'migration-20261107'),
  ('schedule.window_end','"19:30"'::jsonb,'migration-20261107'),
  ('schedule.timezone','"Europe/Malta"'::jsonb,'migration-20261107')
ON CONFLICT (key) DO NOTHING;

COMMIT;
