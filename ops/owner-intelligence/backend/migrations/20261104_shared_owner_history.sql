-- Shared owner history is an authorized projection of the existing relay
-- store.  This migration adds tenant boundaries, message provenance and
-- no-send follow-up tasks; it does not create a second conversation store.
BEGIN;

CREATE TABLE IF NOT EXISTS crm_agencies (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO crm_agencies(slug,name) VALUES('2906','2906 Estate')
ON CONFLICT(slug) DO NOTHING;

-- The application sets app.agency_id for tenant-aware requests.  Legacy
-- ingestion remains attached to the existing 2906 agency until that setting
-- is supplied, so new rows cannot accidentally become tenant-less.
CREATE OR REPLACE FUNCTION crm_current_agency_id() RETURNS BIGINT AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.agency_id', true), '')::BIGINT,
    (SELECT id FROM crm_agencies WHERE slug='2906')
  );
$$ LANGUAGE sql STABLE;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS agency_id BIGINT REFERENCES crm_agencies(id) ON DELETE RESTRICT;
ALTER TABLE owner_contacts ADD COLUMN IF NOT EXISTS agency_id BIGINT REFERENCES crm_agencies(id) ON DELETE RESTRICT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS agency_id BIGINT REFERENCES crm_agencies(id) ON DELETE RESTRICT;
ALTER TABLE book_relay_threads ADD COLUMN IF NOT EXISTS agency_id BIGINT REFERENCES crm_agencies(id) ON DELETE RESTRICT;

WITH agency AS (SELECT id FROM crm_agencies WHERE slug='2906')
UPDATE agents SET agency_id=(SELECT id FROM agency) WHERE agency_id IS NULL;
WITH agency AS (SELECT id FROM crm_agencies WHERE slug='2906')
UPDATE owner_contacts SET agency_id=(SELECT id FROM agency) WHERE agency_id IS NULL;
UPDATE properties p SET agency_id=COALESCE(
  (SELECT agency_id FROM owner_contacts oc WHERE oc.id=p.owner_id),
  (SELECT agency_id FROM agents a WHERE a.id=p.listed_by_agent_id),
  (SELECT id FROM crm_agencies WHERE slug='2906'))
WHERE p.agency_id IS NULL;
UPDATE book_relay_threads t SET agency_id=COALESCE(
  (SELECT agency_id FROM properties p WHERE p.id=t.property_id),
  (SELECT agency_id FROM agents a WHERE a.id=t.agent_id),
  (SELECT id FROM crm_agencies WHERE slug='2906'))
WHERE t.agency_id IS NULL;

ALTER TABLE agents ALTER COLUMN agency_id SET NOT NULL;
ALTER TABLE owner_contacts ALTER COLUMN agency_id SET NOT NULL;
ALTER TABLE properties ALTER COLUMN agency_id SET NOT NULL;
ALTER TABLE book_relay_threads ALTER COLUMN agency_id SET NOT NULL;
ALTER TABLE agents ALTER COLUMN agency_id SET DEFAULT crm_current_agency_id();
ALTER TABLE owner_contacts ALTER COLUMN agency_id SET DEFAULT crm_current_agency_id();
ALTER TABLE properties ALTER COLUMN agency_id SET DEFAULT crm_current_agency_id();
ALTER TABLE book_relay_threads ALTER COLUMN agency_id SET DEFAULT crm_current_agency_id();
CREATE INDEX IF NOT EXISTS agents_agency_idx ON agents(agency_id,id);
CREATE INDEX IF NOT EXISTS owners_agency_idx ON owner_contacts(agency_id,id);
CREATE INDEX IF NOT EXISTS properties_agency_idx ON properties(agency_id,id);
CREATE INDEX IF NOT EXISTS relay_threads_agency_property_idx ON book_relay_threads(agency_id,property_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS relay_threads_agency_owner_idx ON book_relay_threads(agency_id,owner_id,updated_at DESC);

ALTER TABLE book_relay_messages
  ADD COLUMN IF NOT EXISTS sender_role TEXT,
  ADD COLUMN IF NOT EXISTS actor_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_ai BOOLEAN,
  ADD COLUMN IF NOT EXISTS provenance_source TEXT,
  ADD COLUMN IF NOT EXISTS attachment_metadata JSONB;

UPDATE book_relay_messages SET sender_role='OWNER',provenance_source=COALESCE(provenance_source,'BOOK_RELAY')
WHERE direction='owner_to_agent' AND sender_role IS NULL;
UPDATE book_relay_messages SET sender_role='SYSTEM_UNKNOWN',provenance_source=COALESCE(provenance_source,'BOOK_RELAY')
WHERE direction='agent_to_owner' AND sender_role IS NULL;

ALTER TABLE book_relay_messages DROP CONSTRAINT IF EXISTS book_relay_messages_sender_role_check;
ALTER TABLE book_relay_messages ADD CONSTRAINT book_relay_messages_sender_role_check
  CHECK (sender_role IS NULL OR sender_role IN ('OWNER','AGENT','AI','SYSTEM_UNKNOWN'));

CREATE OR REPLACE FUNCTION classify_relay_message_provenance() RETURNS trigger AS $$
BEGIN
  IF NEW.sender_role IS NULL THEN
    NEW.sender_role := CASE
      WHEN NEW.direction='owner_to_agent' THEN 'OWNER'
      ELSE 'SYSTEM_UNKNOWN'
    END;
  END IF;
  IF NEW.provenance_source IS NULL THEN
    NEW.provenance_source := 'BOOK_RELAY';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS book_relay_message_provenance_trigger ON book_relay_messages;
CREATE TRIGGER book_relay_message_provenance_trigger
  BEFORE INSERT ON book_relay_messages
  FOR EACH ROW EXECUTE FUNCTION classify_relay_message_provenance();

CREATE OR REPLACE FUNCTION inherit_relay_agency() RETURNS trigger AS $$
BEGIN
  IF NEW.agency_id IS NULL THEN
    SELECT COALESCE(p.agency_id,a.agency_id) INTO NEW.agency_id
      FROM properties p LEFT JOIN agents a ON a.id=NEW.agent_id WHERE p.id=NEW.property_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS book_relay_thread_agency_trigger ON book_relay_threads;
CREATE TRIGGER book_relay_thread_agency_trigger
  BEFORE INSERT OR UPDATE OF property_id,agent_id ON book_relay_threads
  FOR EACH ROW EXECUTE FUNCTION inherit_relay_agency();

CREATE TABLE IF NOT EXISTS owner_conversation_tasks (
  id BIGSERIAL PRIMARY KEY,
  agency_id BIGINT NOT NULL REFERENCES crm_agencies(id) ON DELETE RESTRICT,
  owner_id INTEGER REFERENCES owner_contacts(id) ON DELETE CASCADE,
  property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
  created_by_agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  assigned_agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('AWAITING_RESPONSE','FOLLOW_UP_REMINDER','REQUEST_CALLBACK','ESCALATE')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','DONE','CANCELLED')),
  due_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS owner_conversation_tasks_queue_idx
  ON owner_conversation_tasks(agency_id,assigned_agent_id,status,due_at NULLS FIRST);

-- Least-privilege role used by the ARGUS API.  The production application
-- role can be granted membership during staged deployment; no service-role
-- credential or public/anonymous access is introduced here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='argus_history_api') THEN
    CREATE ROLE argus_history_api NOLOGIN;
  END IF;
END $$;
GRANT SELECT ON crm_agencies,agents,owner_contacts,properties,book_relay_threads,book_relay_messages,
  property_viewings,owner_group_requests,availability_checks TO argus_history_api;
GRANT SELECT,INSERT,UPDATE ON owner_conversation_tasks TO argus_history_api;
GRANT USAGE,SELECT ON SEQUENCE owner_conversation_tasks_id_seq TO argus_history_api;

COMMIT;
