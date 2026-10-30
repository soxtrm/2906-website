-- Reverse of 20261031_website_publication.sql. Website rows are untouched.
BEGIN;
DROP TRIGGER IF EXISTS properties_website_publication ON properties;
DROP FUNCTION IF EXISTS website_publication_touch();
DROP TABLE IF EXISTS website_publication_state;
COMMIT;
