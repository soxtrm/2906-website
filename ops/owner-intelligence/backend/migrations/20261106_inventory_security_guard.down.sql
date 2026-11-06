BEGIN;

DROP TABLE IF EXISTS agent_inventory_security_events;
DROP TABLE IF EXISTS agent_inventory_security_policies;

ALTER TABLE agents
  DROP COLUMN IF EXISTS security_suspension_cleared_by,
  DROP COLUMN IF EXISTS security_suspension_cleared_at,
  DROP COLUMN IF EXISTS security_suspended_by,
  DROP COLUMN IF EXISTS security_suspension_reason,
  DROP COLUMN IF EXISTS security_suspended_at;

COMMIT;
