-- Rollback of 20261112_reliability_p0.sql. Removes only the two tables that migration created.
BEGIN;
DROP TABLE IF EXISTS upload_packages;
DROP TABLE IF EXISTS worker_heartbeats;
COMMIT;
