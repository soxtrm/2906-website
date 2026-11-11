-- Down migration for 20261111_nexus_owner_link.sql. Drops only the 8 tables the
-- up migration created; nothing else was touched by it.
BEGIN;
DROP TABLE IF EXISTS owner_availability_answers;
DROP TABLE IF EXISTS nexus_inbound_events;
DROP TABLE IF EXISTS nexus_sync_outbox;
DROP TABLE IF EXISTS nexus_distribution_grants;
DROP TABLE IF EXISTS nexus_property_links;
DROP TABLE IF EXISTS nexus_owner_property_claims;
DROP TABLE IF EXISTS nexus_owner_invitations;
DROP TABLE IF EXISTS nexus_owner_links;
COMMIT;
