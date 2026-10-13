BEGIN;

CREATE TABLE IF NOT EXISTS property_photo_processing_runs (
  run_id UUID PRIMARY KEY,
  trigger_id TEXT,
  source TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('pimp','vision')),
  status TEXT NOT NULL,
  property_id BIGINT REFERENCES properties(id) ON DELETE SET NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  edited_count INTEGER NOT NULL DEFAULT 0,
  fallback_count INTEGER NOT NULL DEFAULT 0,
  edit_model TEXT,
  vision_model TEXT,
  audit JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS property_photo_processing_runs_trigger_uidx
  ON property_photo_processing_runs(trigger_id) WHERE trigger_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS property_photo_edits (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES property_photo_processing_runs(run_id) ON DELETE CASCADE,
  property_id BIGINT REFERENCES properties(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,
  source_image_id TEXT NOT NULL,
  edited_image_id TEXT,
  source_image_url TEXT,
  edited_image_url TEXT,
  source_sha256 CHAR(64) NOT NULL,
  edited_sha256 CHAR(64),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('ORIGINAL','GPT_ENHANCED','MANUALLY_EDITED')),
  edit_type TEXT NOT NULL,
  model_version TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, position)
);
CREATE INDEX IF NOT EXISTS property_photo_edits_property_idx ON property_photo_edits(property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS property_photo_edits_source_hash_idx ON property_photo_edits(source_sha256);
CREATE INDEX IF NOT EXISTS property_photo_edits_edited_hash_idx ON property_photo_edits(edited_sha256) WHERE edited_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS property_photo_vision_observations (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES property_photo_processing_runs(run_id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'IMAGE_VISION' CHECK (source = 'IMAGE_VISION'),
  evidence_image_position INTEGER,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS property_photo_vision_observations_property_idx
  ON property_photo_vision_observations(property_id, observed_at DESC);

COMMIT;
