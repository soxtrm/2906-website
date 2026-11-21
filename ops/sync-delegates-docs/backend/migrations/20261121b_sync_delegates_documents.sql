-- NEXUS SYNC representatives (delegates) and private owner documents (Claude, 2026-11-21).
-- Additive: two new tables; new nullable/defaulted columns on owner_documents. Existing rows keep
-- visibility 'agency' and storage 'cloudinary', so every current CRM view behaves as before.
BEGIN;
CREATE TABLE IF NOT EXISTS nexus_owner_delegates (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  agency_key TEXT NOT NULL,
  owner_link_id BIGINT NOT NULL REFERENCES nexus_owner_links(id) ON DELETE CASCADE,
  invited_by_account_id BIGINT NOT NULL REFERENCES sync_accounts(id) ON DELETE CASCADE,
  delegate_account_id BIGINT REFERENCES sync_accounts(id) ON DELETE SET NULL,
  invite_name TEXT NOT NULL CHECK (length(invite_name) BETWEEN 1 AND 80),
  invite_kind TEXT NOT NULL CHECK (invite_kind IN ('email','phone')),
  invite_target TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  permissions TEXT[] NOT NULL CHECK (permissions <@ ARRAY['view','message','schedule','edit']::text[] AND cardinality(permissions) >= 1),
  state TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','revoked','declined')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS nexus_owner_delegates_link ON nexus_owner_delegates (owner_link_id);
CREATE INDEX IF NOT EXISTS nexus_owner_delegates_delegate ON nexus_owner_delegates (delegate_account_id) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS nexus_owner_delegate_properties (
  delegate_id BIGINT NOT NULL REFERENCES nexus_owner_delegates(id) ON DELETE CASCADE,
  property_id INT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  PRIMARY KEY (delegate_id, property_id)
);
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'agency';
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'cloudinary';
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS mime TEXT;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS size_bytes INT;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS sha256 TEXT;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS sync_account_id BIGINT REFERENCES sync_accounts(id) ON DELETE SET NULL;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
ALTER TABLE owner_documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE owner_documents DROP CONSTRAINT IF EXISTS owner_documents_visibility_check;
ALTER TABLE owner_documents ADD CONSTRAINT owner_documents_visibility_check CHECK (visibility IN ('private','agency'));
ALTER TABLE owner_documents DROP CONSTRAINT IF EXISTS owner_documents_storage_check;
ALTER TABLE owner_documents ADD CONSTRAINT owner_documents_storage_check CHECK (storage IN ('cloudinary','sync_private'));
CREATE UNIQUE INDEX IF NOT EXISTS owner_documents_storage_key ON owner_documents (storage_key) WHERE storage_key IS NOT NULL;
COMMIT;
