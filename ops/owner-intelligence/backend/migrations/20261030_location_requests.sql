-- 2026-10-30 Location requests (Kev): one persistent, traceable request per
-- "Ask for Location" click. Idempotent; reverse with
-- 20261030_location_requests.down.sql.
--
-- Status (UI labels in brackets):
--   preparing      action registered, message being built   [Preparing]
--   queued         waiting for the owner's WhatsApp account  [Queued]
--   sent           provider accepted the message             [Sent]
--   awaiting_owner sent, no location in a reply yet          [Awaiting Owner]
--   location_received  owner sent a pin, map link or address [Location Received]
--   agent_notified requesting agent got the in-app notice    [Agent Notified]
--   failed         could not be delivered / processed        [Failed]
--   cancelled      withdrawn or no longer needed             [Cancelled]
-- "sent" is only written after WAHA accepted the message. Delivery/read are
-- NOT tracked here because the provider does not report them to this flow.
BEGIN;

CREATE TABLE IF NOT EXISTS property_location_requests (
  id                    BIGSERIAL PRIMARY KEY,
  property_id           INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ref                   TEXT NOT NULL,
  owner_contact_id      INTEGER REFERENCES owner_contacts(id) ON DELETE SET NULL,
  requested_by_agent_id INTEGER NOT NULL,
  requested_by_name     TEXT,
  viewing_id            INTEGER REFERENCES property_viewings(id) ON DELETE SET NULL,
  session_name          TEXT,
  owner_chat_id         TEXT,
  status                TEXT NOT NULL DEFAULT 'preparing'
                        CHECK (status IN ('preparing','queued','sent','awaiting_owner','location_received','agent_notified','failed','cancelled')),
  message_text          TEXT,
  provider_message_id   TEXT,
  error                 TEXT,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at               TIMESTAMPTZ,
  last_owner_reply_at   TIMESTAMPTZ,
  last_owner_reply_text TEXT,
  answered_at           TIMESTAMPTZ,
  answer_kind           TEXT CHECK (answer_kind IN ('pin','maps_link','address')),
  answer_text           TEXT,
  answer_message_id     TEXT,
  maps_url              TEXT,
  latitude              NUMERIC(10,7),
  longitude             NUMERIC(10,7),
  address_text          TEXT,
  notified_at           TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancel_reason         TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open request per property: repeated clicks / two agents / retries can
-- never create a second one while the first is still in flight.
CREATE UNIQUE INDEX IF NOT EXISTS property_location_requests_one_open
  ON property_location_requests(property_id)
  WHERE status IN ('preparing','queued','sent','awaiting_owner');
CREATE INDEX IF NOT EXISTS property_location_requests_owner_open
  ON property_location_requests(owner_contact_id)
  WHERE status IN ('sent','awaiting_owner');
CREATE INDEX IF NOT EXISTS property_location_requests_property
  ON property_location_requests(property_id, requested_at DESC);

COMMIT;
