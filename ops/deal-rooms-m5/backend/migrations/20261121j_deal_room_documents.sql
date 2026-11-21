-- NEXUS Deal Room M5 (2026-11-21): documents and evidence, generated contract / invoice drafts, payment requests.
-- Files reuse the private ARGUS document store (private-docs/, never public, ClamAV-scanned) in a deal-rooms/ folder.
-- No money is held or moved here: a payment request has explicit states, and "verified" needs a provider event or an
-- authorised manual reconciliation with a reference. Additive only (the event kind list is widened, nothing removed).
BEGIN;
CREATE TABLE IF NOT EXISTS deal_room_documents (
  id             bigserial PRIMARY KEY,
  deal_room_id   uuid NOT NULL REFERENCES deal_rooms(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('photo', 'video', 'document', 'condition_evidence', 'contract_draft', 'invoice_draft', 'signed_document')),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  filename       text,
  mime           text,
  size_bytes     integer,
  sha256         text,
  storage_key    text,                    -- uploaded files: private-docs/deal-rooms/<key>; generated drafts keep body instead
  body           text,                    -- generated drafts (HTML)
  version        integer NOT NULL DEFAULT 1,
  supersedes     bigint REFERENCES deal_room_documents(id) ON DELETE SET NULL,
  actor          text NOT NULL CHECK (actor IN ('visitor', 'staff', 'system')),
  agent_id       integer REFERENCES agents(id) ON DELETE SET NULL,
  visibility     text NOT NULL DEFAULT 'parties' CHECK (visibility IN ('parties', 'staff')),
  scan_state     text NOT NULL DEFAULT 'not_applicable' CHECK (scan_state IN ('clean', 'pending', 'infected', 'not_applicable')),
  capture_meta   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- what the device reported (never treated as proof; no GPS stored)
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS deal_room_documents_room_idx ON deal_room_documents (deal_room_id, id);

CREATE TABLE IF NOT EXISTS deal_room_document_access (
  id           bigserial PRIMARY KEY,
  document_id  bigint NOT NULL REFERENCES deal_room_documents(id) ON DELETE CASCADE,
  actor        text NOT NULL CHECK (actor IN ('visitor', 'staff')),
  agent_id     integer REFERENCES agents(id) ON DELETE SET NULL,
  action       text NOT NULL CHECK (action IN ('download', 'refused')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_room_document_access_doc_idx ON deal_room_document_access (document_id, id);

CREATE TABLE IF NOT EXISTS deal_room_payment_requests (
  id             bigserial PRIMARY KEY,
  deal_room_id   uuid NOT NULL REFERENCES deal_rooms(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('deposit', 'first_rent', 'agency_fee', 'other')),
  label          text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  amount_cents   integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  currency       text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'initiated', 'pending', 'verified', 'failed', 'refunded', 'cancelled')),
  verified_via   text CHECK (verified_via IN ('provider_event', 'manual_reconciliation')),
  reference      text CHECK (reference IS NULL OR length(reference) <= 120),
  note           text CHECK (note IS NULL OR length(note) <= 600),
  created_by     integer REFERENCES agents(id) ON DELETE SET NULL,
  updated_by     integer REFERENCES agents(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'verified' OR (verified_via IS NOT NULL AND reference IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS deal_room_payment_requests_room_idx ON deal_room_payment_requests (deal_room_id, id);

ALTER TABLE deal_room_events DROP CONSTRAINT IF EXISTS deal_room_events_kind_check;
ALTER TABLE deal_room_events ADD CONSTRAINT deal_room_events_kind_check CHECK (kind IN (
  'created', 'viewing_requested', 'viewing_booked', 'viewing_declined', 'stage', 'note',
  'document_added', 'document_removed', 'draft_created', 'payment_requested', 'payment_status'));
COMMIT;
