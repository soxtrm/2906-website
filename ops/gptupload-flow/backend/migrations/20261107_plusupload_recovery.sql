BEGIN;

ALTER TABLE property_photo_processing_runs
  DROP CONSTRAINT IF EXISTS property_photo_processing_runs_mode_check;
ALTER TABLE property_photo_processing_runs
  ADD CONSTRAINT property_photo_processing_runs_mode_check
  CHECK (mode IN ('pimp','conservative','premium','vision'));

ALTER TABLE property_photo_processing_runs
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS retry_available BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parent_run_id UUID REFERENCES property_photo_processing_runs(run_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS property_photo_processing_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES property_photo_processing_runs(run_id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('received','processing','generated','quality_checked','saved','ready','failed')),
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS property_photo_processing_events_run_idx
  ON property_photo_processing_events(run_id, created_at);

COMMIT;
