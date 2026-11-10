-- Reverse of 20261110_owner_ai_recal.sql. properties.floor_level/parking_type are
-- deliberately kept: live conversationIntelligence (2026-11-10 14:20 deploy)
-- requires them; dropping them would break inbound processing again.
BEGIN;
DROP TABLE IF EXISTS owner_ai_quality_schedule;
DROP TABLE IF EXISTS owner_ai_regression_runs;
DROP TABLE IF EXISTS owner_ai_quality_incidents;
DROP TABLE IF EXISTS owner_ai_fixture_candidates;
DROP TABLE IF EXISTS owner_ai_quality_reviews;
DROP TABLE IF EXISTS owner_ai_quality_reports;
DROP TABLE IF EXISTS owner_ai_decisions;
COMMIT;
