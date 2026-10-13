BEGIN;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS dashboard_preferences JSONB NOT NULL DEFAULT
  '{"focus":72,"outreach":55,"motion":62}'::jsonb;

UPDATE agents
   SET dashboard_preferences = '{"focus":72,"outreach":55,"motion":62}'::jsonb
 WHERE dashboard_preferences IS NULL;

COMMIT;
