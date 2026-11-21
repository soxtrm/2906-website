-- NEXUS Marketplace conversations (2026-11-21): a visitor writes to the listing agency about one home; the
-- agency answers from its inbox; a viewing request becomes a real ARGUS booking only when staff book a slot
-- (services/bookingEngine.createSlotBooking -> property_viewings -> the owner's SYNC calendar).
-- Additive only. The visitor's access is a random token whose SHA-256 is stored, never the token itself.
BEGIN;
CREATE TABLE IF NOT EXISTS mp_conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_key         text NOT NULL,
  property_id        integer REFERENCES properties(id) ON DELETE SET NULL,
  listing_ref        text NOT NULL,
  assigned_agent_id  integer REFERENCES agents(id) ON DELETE SET NULL,
  visitor_name       text NOT NULL CHECK (length(visitor_name) BETWEEN 1 AND 120),
  visitor_email      text CHECK (visitor_email IS NULL OR length(visitor_email) <= 254),
  visitor_phone      text CHECK (visitor_phone IS NULL OR length(visitor_phone) <= 32),
  visitor_role       text NOT NULL DEFAULT 'home-seeker' CHECK (visitor_role IN ('home-seeker', 'agent')),
  token_hash         text NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  staff_unread       integer NOT NULL DEFAULT 0,
  visitor_unread     integer NOT NULL DEFAULT 0,
  last_message_at    timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_ip_hash    text
);
CREATE INDEX IF NOT EXISTS mp_conversations_agency_idx ON mp_conversations (agency_key, last_message_at DESC);
CREATE INDEX IF NOT EXISTS mp_conversations_agent_idx ON mp_conversations (assigned_agent_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS mp_conversations_property_idx ON mp_conversations (property_id);

CREATE TABLE IF NOT EXISTS mp_messages (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES mp_conversations(id) ON DELETE CASCADE,
  sender           text NOT NULL CHECK (sender IN ('visitor', 'staff', 'system')),
  agent_id         integer REFERENCES agents(id) ON DELETE SET NULL,
  kind             text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'viewing_request', 'viewing_update')),
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mp_messages_conv_idx ON mp_messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS mp_viewing_requests (
  id                   bigserial PRIMARY KEY,
  conversation_id      uuid NOT NULL REFERENCES mp_conversations(id) ON DELETE CASCADE,
  property_id          integer REFERENCES properties(id) ON DELETE SET NULL,
  listing_ref          text NOT NULL,
  preferred            jsonb NOT NULL DEFAULT '[]'::jsonb,
  note                 text CHECK (note IS NULL OR length(note) <= 700),
  status               text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'booked', 'declined', 'cancelled')),
  property_viewing_id  integer REFERENCES property_viewings(id) ON DELETE SET NULL,
  decided_by           integer REFERENCES agents(id) ON DELETE SET NULL,
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mp_viewing_requests_conv_idx ON mp_viewing_requests (conversation_id);
CREATE INDEX IF NOT EXISTS mp_viewing_requests_open_idx ON mp_viewing_requests (status) WHERE status = 'requested';
COMMIT;
