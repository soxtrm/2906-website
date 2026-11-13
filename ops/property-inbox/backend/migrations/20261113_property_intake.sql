-- ============================================================================
-- 20261113_property_intake.sql — Incoming Properties / content verification
-- ADDITIVE: new nullable columns, one partial index, one backfill of the four
-- divider-upload drafts recovered on 2026-11-12. No existing value changes.
-- verification_status NULL = the property did not come through an intake
-- channel (every listing before this migration); it is not "unverified".
-- ============================================================================
BEGIN;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS verification_status TEXT,
  ADD COLUMN IF NOT EXISTS verification_note TEXT,
  ADD COLUMN IF NOT EXISTS verified_by_agent_id INTEGER REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intake_source TEXT,
  ADD COLUMN IF NOT EXISTS intake_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intake_package_id BIGINT,
  ADD COLUMN IF NOT EXISTS intake_linked_property_id INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_verification_status_chk') THEN
    ALTER TABLE properties ADD CONSTRAINT properties_verification_status_chk
      CHECK (verification_status IS NULL OR verification_status IN ('unverified', 'needs_correction', 'verified'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS properties_intake_idx ON properties (intake_received_at DESC) WHERE intake_source IS NOT NULL;

ALTER TABLE upload_packages
  ADD COLUMN IF NOT EXISTS resolution TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by_agent_id INTEGER REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- The drafts the divider flow created so far. Upload time = first message of the
-- package (WhatsApp time), not the time the recovery ran.
UPDATE properties p
   SET verification_status = 'unverified', intake_source = 'whatsapp_divider', intake_package_id = u.id,
       intake_received_at = to_timestamp(COALESCE(u.first_message_ts, u.divider_ts))
  FROM upload_packages u
 WHERE p.id = ANY (u.property_ids) AND p.intake_source IS NULL;

-- A later package that was a duplicate of an earlier upload of the same text:
-- the property keeps the EARLIEST WhatsApp upload time (Olga's original).
UPDATE properties p
   SET intake_received_at = LEAST(p.intake_received_at, to_timestamp(COALESCE(d.first_message_ts, d.divider_ts)))
  FROM upload_packages d
 WHERE d.state = 'DUPLICATE' AND d.failure_reason = 'duplicate of #' || p.ref AND p.intake_source = 'whatsapp_divider';

COMMIT;
