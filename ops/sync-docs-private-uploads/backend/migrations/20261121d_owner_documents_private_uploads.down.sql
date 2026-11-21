BEGIN;
DROP TRIGGER IF EXISTS owner_documents_private_link ON owner_documents;
DROP FUNCTION IF EXISTS owner_documents_private_link();
DROP TABLE IF EXISTS owner_document_staging;
COMMIT;
