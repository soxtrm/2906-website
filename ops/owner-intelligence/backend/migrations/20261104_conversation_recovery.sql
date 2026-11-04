-- ARGUS owner conversation recovery (2026-11-04).
-- Additive, tenant-safe persistence for ambiguity review, processing reasons,
-- sourced facts and durable relay metadata.  No message is sent by this
-- migration and no inventory status is changed.
BEGIN;

CREATE TABLE IF NOT EXISTS conversation_review_tasks (
  id                     BIGSERIAL PRIMARY KEY,
  state_id               BIGINT NOT NULL REFERENCES conversation_intelligence_state(id) ON DELETE CASCADE,
  owner_contact_id       INTEGER REFERENCES owner_contacts(id) ON DELETE CASCADE,
  source_message_id      TEXT NOT NULL,
  review_type            TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  reason                 TEXT NOT NULL,
  evidence               TEXT,
  candidate_property_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolution             JSONB,
  resolved_by_agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  resolved_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (state_id, source_message_id, review_type)
);
CREATE INDEX IF NOT EXISTS conversation_review_tasks_open
  ON conversation_review_tasks(owner_contact_id, created_at DESC) WHERE status='OPEN';

CREATE TABLE IF NOT EXISTS conversation_processing_events (
  id                   BIGSERIAL PRIMARY KEY,
  state_id             BIGINT REFERENCES conversation_intelligence_state(id) ON DELETE CASCADE,
  source_message_id    TEXT NOT NULL,
  processing_status    TEXT NOT NULL,
  reason_code          TEXT,
  reason_detail        TEXT,
  automation_status    TEXT,
  sender_account_id    TEXT,
  property_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (state_id, source_message_id, processing_status, reason_code)
);
CREATE INDEX IF NOT EXISTS conversation_processing_events_state
  ON conversation_processing_events(state_id, created_at DESC);

ALTER TABLE conversation_intelligence_state
  ADD COLUMN IF NOT EXISTS automation_status TEXT,
  ADD COLUMN IF NOT EXISTS automation_reason TEXT,
  ADD COLUMN IF NOT EXISTS automation_changed_by_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS automation_changed_at TIMESTAMPTZ;

ALTER TABLE conversation_facts
  ADD COLUMN IF NOT EXISTS access_scope TEXT NOT NULL DEFAULT 'AUTHORIZED_AGENT',
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_by_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS correction_note TEXT;

ALTER TABLE book_relay_messages
  ADD COLUMN IF NOT EXISTS source_message_id TEXT,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referenced_property_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The deployed relay service already writes every Board/owner message to this
-- durable table.  Populate the new audit columns centrally so older service
-- processes cannot silently omit them during a staged rollout.
CREATE OR REPLACE FUNCTION enrich_book_relay_message_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE relay_agent INTEGER; relay_property INTEGER;
BEGIN
  SELECT agent_id,property_id INTO relay_agent,relay_property
    FROM book_relay_threads WHERE id=NEW.thread_id;
  NEW.source_message_id := COALESCE(NEW.source_message_id, 'relay:' || NEW.thread_id || ':' || NEW.id);
  NEW.delivery_status := CASE
    WHEN NEW.direction='owner_to_agent' THEN 'RECEIVED'
    WHEN NEW.wa_message_id IS NOT NULL AND COALESCE(NEW.delivery_status,'QUEUED')='QUEUED' THEN 'SENT'
    ELSE COALESCE(NEW.delivery_status,'QUEUED') END;
  NEW.agent_id := COALESCE(NEW.agent_id,relay_agent);
  IF COALESCE(jsonb_array_length(NEW.referenced_property_ids),0)=0 AND relay_property IS NOT NULL THEN
    NEW.referenced_property_ids := jsonb_build_array(relay_property);
  END IF;
  RETURN NEW;
END $$;

UPDATE book_relay_messages m SET
  source_message_id=COALESCE(m.source_message_id,'relay:' || m.thread_id || ':' || m.id),
  delivery_status=CASE
    WHEN m.direction='owner_to_agent' THEN 'RECEIVED'
    WHEN m.wa_message_id IS NOT NULL AND COALESCE(m.delivery_status,'QUEUED')='QUEUED' THEN 'SENT'
    ELSE COALESCE(m.delivery_status,'QUEUED') END,
  agent_id=COALESCE(m.agent_id,t.agent_id),
  referenced_property_ids=CASE
    WHEN COALESCE(jsonb_array_length(m.referenced_property_ids),0)=0 AND t.property_id IS NOT NULL
      THEN jsonb_build_array(t.property_id)
    ELSE m.referenced_property_ids END
FROM book_relay_threads t WHERE t.id=m.thread_id;

CREATE UNIQUE INDEX IF NOT EXISTS book_relay_messages_source_once
  ON book_relay_messages(thread_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
DROP TRIGGER IF EXISTS book_relay_message_audit_trigger ON book_relay_messages;
CREATE TRIGGER book_relay_message_audit_trigger
  BEFORE INSERT OR UPDATE ON book_relay_messages
  FOR EACH ROW EXECUTE FUNCTION enrich_book_relay_message_audit();

ALTER TABLE book_relay_threads
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_by_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;

COMMIT;
