BEGIN;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS operational_status TEXT;
DO $$ BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_operational_status_check
    CHECK (operational_status IS NULL OR operational_status IN ('AVAILABLE','UPCOMING','NOT_READY','COMPLIANCE_PENDING','RENTED','SOLD','WITHDRAWN','NEEDS_HUMAN_REVIEW'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS conversation_intelligence_state (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_account_id TEXT NOT NULL,
  owner_contact_id BIGINT REFERENCES owner_contacts(id) ON DELETE SET NULL,
  conversation_version BIGINT NOT NULL DEFAULT 0,
  property_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_question_type TEXT,
  last_asked_field TEXT,
  last_inbound_message_id TEXT,
  last_inbound_at TIMESTAMPTZ,
  contact_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  human_active BOOLEAN NOT NULL DEFAULT FALSE,
  compliance_review_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chat_id,sender_account_id)
);

CREATE TABLE IF NOT EXISTS conversation_message_revisions (
  id BIGSERIAL PRIMARY KEY,
  state_id BIGINT NOT NULL REFERENCES conversation_intelligence_state(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'owner_reported',
  revision_no INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('ORIGINAL','EDITED')),
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  source_timestamp TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(state_id,source_message_id,body_hash),
  UNIQUE(state_id,source_message_id,revision_no)
);

CREATE TABLE IF NOT EXISTS conversation_facts (
  id BIGSERIAL PRIMARY KEY,
  state_id BIGINT NOT NULL REFERENCES conversation_intelligence_state(id) ON DELETE CASCADE,
  entity_id BIGINT,
  property_id BIGINT REFERENCES properties(id) ON DELETE SET NULL,
  sender_account_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value JSONB,
  fact_status TEXT NOT NULL CHECK(fact_status IN ('KNOWN','UNKNOWN','CONFLICTING','CONDITIONAL','SUPERSEDED')),
  source_message_id TEXT NOT NULL,
  source_timestamp TIMESTAMPTZ NOT NULL,
  confidence NUMERIC(4,3) NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  effective_timestamp TIMESTAMPTZ NOT NULL,
  superseded_by TEXT,
  last_confirmed_at TIMESTAMPTZ,
  evidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conversation_facts_active_idx ON conversation_facts(state_id,field_name,effective_timestamp DESC) WHERE fact_status<>'SUPERSEDED';

CREATE TABLE IF NOT EXISTS conversation_outbound_guard (
  id BIGSERIAL PRIMARY KEY,
  state_id BIGINT NOT NULL REFERENCES conversation_intelligence_state(id) ON DELETE CASCADE,
  source_message_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  draft TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('CLAIMED','SENT','BLOCKED','FAILED')),
  sent_message_id TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS property_operational_status_history (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('AVAILABLE','UPCOMING','NOT_READY','COMPLIANCE_PENDING','RENTED','SOLD','WITHDRAWN','NEEDS_HUMAN_REVIEW')),
  source_message_id TEXT,
  source_timestamp TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
