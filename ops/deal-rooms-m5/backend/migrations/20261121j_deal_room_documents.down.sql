-- Rollback of 20261121j: refuses when documents or payment requests exist (never drops data).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM deal_room_documents) OR EXISTS (SELECT 1 FROM deal_room_payment_requests) THEN
    RAISE EXCEPTION 'deal room documents / payment requests exist: not dropping (roll back the code only)';
  END IF;
END $$;
DROP TABLE IF EXISTS deal_room_document_access;
DROP TABLE IF EXISTS deal_room_documents;
DROP TABLE IF EXISTS deal_room_payment_requests;
ALTER TABLE deal_room_events DROP CONSTRAINT IF EXISTS deal_room_events_kind_check;
ALTER TABLE deal_room_events ADD CONSTRAINT deal_room_events_kind_check CHECK (kind IN ('created', 'viewing_requested', 'viewing_booked', 'viewing_declined', 'stage', 'note'));
