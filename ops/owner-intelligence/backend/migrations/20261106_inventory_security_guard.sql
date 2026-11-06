-- Narrow Inventory abuse guard for the explicitly protected agency accounts.
-- Existing roles and permissions are deliberately left untouched.  A security
-- suspension is an independent, reversible access state.
BEGIN;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS security_suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS security_suspension_reason TEXT,
  ADD COLUMN IF NOT EXISTS security_suspended_by TEXT,
  ADD COLUMN IF NOT EXISTS security_suspension_cleared_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS security_suspension_cleared_by INTEGER REFERENCES agents(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS agent_inventory_security_policies (
  agent_id INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  delete_attempt_limit SMALLINT NOT NULL DEFAULT 2 CHECK(delete_attempt_limit >= 0),
  delete_window_minutes SMALLINT NOT NULL DEFAULT 1440 CHECK(delete_window_minutes BETWEEN 1 AND 10080),
  detail_burst_limit SMALLINT NOT NULL DEFAULT 60 CHECK(detail_burst_limit >= 10),
  detail_burst_window_minutes SMALLINT NOT NULL DEFAULT 10 CHECK(detail_burst_window_minutes BETWEEN 1 AND 1440),
  detail_hour_limit SMALLINT NOT NULL DEFAULT 150 CHECK(detail_hour_limit >= detail_burst_limit),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_inventory_security_events (
  id BIGSERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'LISTING_DETAIL_OPENED',
    'LISTING_DELETE_ATTEMPTED',
    'INVENTORY_SECURITY_SUSPENDED',
    'INVENTORY_SECURITY_CLEARED'
  )),
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  property_ref TEXT,
  route TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_inventory_security_events_agent_time_idx
  ON agent_inventory_security_events(agent_id,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_inventory_security_events_type_time_idx
  ON agent_inventory_security_events(agent_id,event_type,created_at DESC);

-- The user named these people explicitly. Match stable account identity fields,
-- not numeric IDs, and do not broaden the policy to every agent/admin.
INSERT INTO agent_inventory_security_policies(agent_id)
SELECT DISTINCT a.id
  FROM agents a
 CROSS JOIN LATERAL unnest(ARRAY[
   COALESCE(a.username,''), COALESCE(a.name,''),
   COALESCE(a.display_name,''), COALESCE(a.alias,'')
 ]) AS identity(value)
 WHERE LOWER(identity.value) ~ '(^|[^a-z])(olga|adrian|tomas)([^a-z]|$)'
    OR LOWER(regexp_replace(identity.value,'[^a-z0-9]+','','g')) IN ('olga','adrian','tomas')
ON CONFLICT(agent_id) DO UPDATE SET enabled=TRUE,updated_at=NOW();

COMMIT;
