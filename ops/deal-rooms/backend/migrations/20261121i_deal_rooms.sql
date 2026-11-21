-- NEXUS Deal Room (2026-11-21, Milestone 3): one persistent transaction workspace per qualifying enquiry, built on
-- the existing Marketplace conversation (mp_conversations) - no second chat backend. Created automatically when the
-- visitor asks for a viewing; advanced by the agency (viewing booked, viewing done, offer, terms, contract, completed).
-- No payments, no identity release here (later milestones, separate approval). Additive only.
BEGIN;
CREATE TABLE IF NOT EXISTS deal_rooms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_key        text NOT NULL,
  property_id       integer REFERENCES properties(id) ON DELETE SET NULL,
  listing_ref       text NOT NULL,
  conversation_id   uuid NOT NULL REFERENCES mp_conversations(id) ON DELETE CASCADE,
  relationship      text NOT NULL DEFAULT 'client_agent' CHECK (relationship IN ('client_agent', 'client_owner', 'agent_owner')),
  agent_id          integer REFERENCES agents(id) ON DELETE SET NULL,
  stage             text NOT NULL DEFAULT 'viewing_requested'
                    CHECK (stage IN ('viewing_requested', 'viewing_booked', 'viewing_done', 'offer', 'terms_agreed', 'contract', 'completed', 'cancelled')),
  stage_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_from      text NOT NULL CHECK (created_from IN ('viewing_request', 'staff')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);
-- one open Deal Room per conversation: a second viewing request on the same enquiry links to the same room
CREATE UNIQUE INDEX IF NOT EXISTS deal_rooms_one_open_per_conversation ON deal_rooms (conversation_id) WHERE stage NOT IN ('completed', 'cancelled');
CREATE INDEX IF NOT EXISTS deal_rooms_agency_idx ON deal_rooms (agency_key, stage_changed_at DESC);
CREATE INDEX IF NOT EXISTS deal_rooms_agent_idx ON deal_rooms (agent_id, stage_changed_at DESC);

CREATE TABLE IF NOT EXISTS deal_room_events (
  id            bigserial PRIMARY KEY,
  deal_room_id  uuid NOT NULL REFERENCES deal_rooms(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('created', 'viewing_requested', 'viewing_booked', 'viewing_declined', 'stage', 'note')),
  actor         text NOT NULL CHECK (actor IN ('visitor', 'staff', 'system')),
  agent_id      integer REFERENCES agents(id) ON DELETE SET NULL,
  visibility    text NOT NULL DEFAULT 'parties' CHECK (visibility IN ('parties', 'staff')),
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_room_events_room_idx ON deal_room_events (deal_room_id, id);
COMMIT;
