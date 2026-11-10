BEGIN;

ALTER TABLE property_photo_processing_runs
  ADD COLUMN IF NOT EXISTS expected_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accepted_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS needs_review_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stalled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agency_scope TEXT,
  ADD COLUMN IF NOT EXISTS agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_session TEXT,
  ADD COLUMN IF NOT EXISTS source_chat_hash CHAR(64);

ALTER TABLE property_photo_edits
  ADD COLUMN IF NOT EXISTS item_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS item_state TEXT NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phase_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS failure_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS property_photo_edits_item_id_uidx
  ON property_photo_edits(item_id);
CREATE INDEX IF NOT EXISTS property_photo_runs_phase_idx
  ON property_photo_processing_runs(phase, worker_heartbeat_at, created_at);

UPDATE property_photo_processing_runs r SET
  expected_count=GREATEST(r.source_count,COALESCE(r.expected_count,0)),
  accepted_count=GREATEST(r.source_count,COALESCE(r.accepted_count,0)),
  completed_count=(SELECT COUNT(*) FROM property_photo_edits e WHERE e.run_id=r.run_id AND e.status IN ('saved','ready')),
  failed_count=(SELECT COUNT(*) FROM property_photo_edits e WHERE e.run_id=r.run_id AND e.status='failed'),
  phase=CASE
    WHEN r.status='ready' THEN 'READY'
    WHEN COALESCE(r.failure_reason,'') ILIKE '%billing%' OR COALESCE(r.failure_reason,'') ILIKE '%credit%' THEN 'BLOCKED_PROVIDER'
    WHEN r.status='failed' THEN 'FAILED_RETRYABLE'
    WHEN r.status='processing' THEN 'PROCESSING'
    ELSE UPPER(r.status)
  END,
  failure_code=CASE
    WHEN COALESCE(r.failure_reason,'') ILIKE '%billing%' OR COALESCE(r.failure_reason,'') ILIKE '%credit%' THEN 'PROVIDER_BILLING_BLOCKED'
    ELSE r.failure_code
  END;

UPDATE property_photo_edits SET
  item_state=CASE
    WHEN status IN ('saved','ready') THEN 'COMPLETED'
    WHEN status='failed' THEN 'FAILED_RETRYABLE'
    ELSE 'NEEDS_REVIEW'
  END,
  failure_code=CASE
    WHEN COALESCE(error,'') ILIKE '%billing%' OR COALESCE(error,'') ILIKE '%credit%' THEN 'PROVIDER_BILLING_BLOCKED'
    ELSE failure_code
  END;

ALTER TABLE property_photo_processing_events
  DROP CONSTRAINT IF EXISTS property_photo_processing_events_stage_check;
ALTER TABLE property_photo_processing_events
  ADD CONSTRAINT property_photo_processing_events_stage_check CHECK (stage IN
    ('received','queued','processing','generated','quality_checked','saved','ready',
     'needs_review','blocked','paused','cancelled','stalled','resumed','failed'));

COMMIT;
