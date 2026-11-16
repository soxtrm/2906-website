-- Reverses 20261116_owner_portal.sql. Drops only the tables it created.
-- property_viewings rows created by the portal stay (source = 'owner_portal');
-- property_viewing_windows rows with source_type = 'owner_portal' are removed.
BEGIN;
DELETE FROM property_viewing_windows WHERE source_type = 'owner_portal';
DROP TABLE IF EXISTS owner_pilot_states, viewing_coordination_events, viewing_coordination, owner_share_links,
  owner_distribution_settings, owner_property_media, owner_property_submissions, owner_property_proposals,
  owner_viewing_rules, owner_portal_audit, owner_portal_sessions, owner_portal_invitations,
  owner_portal_delegates, owner_portal_accounts;
COMMIT;
