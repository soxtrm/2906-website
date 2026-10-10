BEGIN;

ALTER TABLE whatsapp_accounts
  ADD COLUMN IF NOT EXISTS operational_status TEXT NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS restriction_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restriction_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restriction_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_session_status TEXT,
  ADD COLUMN IF NOT EXISTS last_session_check_at TIMESTAMPTZ;

ALTER TABLE outreach_batches
  ADD COLUMN IF NOT EXISTS volume_percent_snapshot INTEGER;

CREATE TABLE IF NOT EXISTS outreach_account_events (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  session_status TEXT,
  reason TEXT,
  restricted_until TIMESTAMPTZ,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_account_events_account_time
  ON outreach_account_events(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outreach_account_events_type_time
  ON outreach_account_events(event_type, created_at DESC);

-- Draft, saved and failed plans are editable previews. They must not remove
-- contacts from the shared pool before ARM acquires the reservation.
UPDATE outreach_reservations r
   SET released_at = NOW(),
       override_reason = COALESCE(r.override_reason, 'release_unarmed_preview_20261010')
  FROM outreach_plans p
 WHERE r.plan_id = p.id
   AND r.released_at IS NULL
   AND p.armed = FALSE;

COMMIT;
