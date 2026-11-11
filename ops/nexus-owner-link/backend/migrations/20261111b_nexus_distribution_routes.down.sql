-- Down migration for 20261111b_nexus_distribution_routes.sql.
BEGIN;
DROP TABLE IF EXISTS nexus_distribution_routes;
COMMIT;
