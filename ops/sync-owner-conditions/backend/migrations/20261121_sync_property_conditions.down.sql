-- Removes the owner conditions table (and every condition in it). Only for a rollback right after the release.
BEGIN;
DROP TABLE IF EXISTS nexus_property_conditions;
COMMIT;
