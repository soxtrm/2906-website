BEGIN;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS can_create_owner_group BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE agents
   SET can_create_owner_group = TRUE, updated_at = NOW()
 WHERE role = 'admin'
    OR LOWER(COALESCE(username, '')) IN ('olga', 'katja', 'katya')
    OR LOWER(COALESCE(name, '')) IN ('olga', 'katja', 'katya');

ALTER TABLE owner_contacts
  ADD COLUMN IF NOT EXISTS owner_group_policy TEXT NOT NULL DEFAULT 'EXPLICIT_APPROVAL_REQUIRED';
ALTER TABLE owner_contacts
  ADD COLUMN IF NOT EXISTS owner_group_trusted_relationships JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS owner_group_requests (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES owner_contacts(id) ON DELETE RESTRICT,
  requesting_agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  viewing_id INTEGER REFERENCES property_viewings(id) ON DELETE SET NULL,
  source_session TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'GROUP_REQUEST_DRAFT',
  approval_policy TEXT NOT NULL DEFAULT 'EXPLICIT_APPROVAL_REQUIRED',
  expires_at TIMESTAMPTZ NOT NULL,
  linked_client_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_context JSONB NOT NULL DEFAULT '[]'::jsonb,
  relationship TEXT,
  move_in_date DATE,
  viewing_intent TEXT,
  requester_note TEXT,
  owner_message TEXT NOT NULL,
  owner_reply_text TEXT,
  owner_reply_message_id TEXT,
  owner_replied_at TIMESTAMPTZ,
  resolution_source TEXT,
  group_jid TEXT,
  group_name TEXT,
  group_created_at TIMESTAMPTZ,
  group_closed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_group_requests_status_check CHECK (status IN (
    'GROUP_REQUEST_DRAFT','GROUP_REQUEST_PENDING','GROUP_REQUEST_APPROVED',
    'GROUP_REQUEST_DECLINED','GROUP_REQUEST_TIMEOUT','GROUP_CREATING',
    'GROUP_CREATED','GROUP_ACTIVE','GROUP_CLOSED','GROUP_REQUEST_FAILED',
    'GROUP_REQUEST_CANCELLED','GROUP_CREATION_AMBIGUOUS'
  )),
  CONSTRAINT owner_group_requests_policy_check CHECK (approval_policy IN (
    'EXPLICIT_APPROVAL_REQUIRED','TRUSTED_AGENT_TIMEOUT_CREATE'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS owner_group_requests_one_open_per_property_agent
  ON owner_group_requests(property_id, requesting_agent_id)
  WHERE status IN ('GROUP_REQUEST_DRAFT','GROUP_REQUEST_PENDING','GROUP_REQUEST_APPROVED','GROUP_CREATING');
CREATE UNIQUE INDEX IF NOT EXISTS owner_group_requests_group_jid_unique
  ON owner_group_requests(group_jid) WHERE group_jid IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_group_requests_pending_due_idx
  ON owner_group_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS owner_group_requests_agent_idx
  ON owner_group_requests(requesting_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS owner_group_requests_owner_session_idx
  ON owner_group_requests(owner_id, source_session, created_at DESC);

CREATE TABLE IF NOT EXISTS owner_group_request_events (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES owner_group_requests(request_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_group_request_events_request_idx
  ON owner_group_request_events(request_id, created_at ASC);

COMMIT;
