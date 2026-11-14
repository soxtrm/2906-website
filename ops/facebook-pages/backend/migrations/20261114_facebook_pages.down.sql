-- Reverts 20261114_facebook_pages.sql. Drops ONLY the agent_facebook_* tables.
-- Run only after the routes are unmounted; publication history is lost.
BEGIN;
DROP TABLE IF EXISTS agent_facebook_deletion_requests;
DROP TABLE IF EXISTS agent_facebook_publications;
DROP TABLE IF EXISTS agent_facebook_templates;
DROP TABLE IF EXISTS agent_facebook_preferences;
DROP TABLE IF EXISTS agent_facebook_pages;
DROP TABLE IF EXISTS agent_facebook_connections;
DROP TABLE IF EXISTS agent_facebook_oauth_states;
DROP TABLE IF EXISTS agent_facebook_credentials;
COMMIT;
