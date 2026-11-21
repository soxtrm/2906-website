-- NEXUS Sync calendar 2.0 (2026-11-21): the owner's own appointments are viewings with source 'owner_sync'.
-- Only widens the allowed values; every existing row stays valid. One short ALTER, no data change.
ALTER TABLE property_viewings DROP CONSTRAINT IF EXISTS property_viewings_source_check,
  ADD CONSTRAINT property_viewings_source_check CHECK (source = ANY (ARRAY['admin_book'::text, 'agent_book'::text, 'client_book'::text, 'cron'::text, 'board_slot'::text, 'owner_sync'::text]));
