BEGIN;
UPDATE owner_contacts o SET owner_contact_paused_until = b.owner_contact_paused_until FROM owner_pause_backup_20261122 b WHERE b.id = o.id;
DROP TABLE IF EXISTS owner_reply_guard_events;
COMMIT;
