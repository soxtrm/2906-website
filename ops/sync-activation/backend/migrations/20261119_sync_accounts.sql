-- NEXUS SYNC owner accounts (Claude, 2026-11-19).
-- The SYNC login layer: who can sign in to nexussync.one. Owner and property
-- data stay in owner_contacts / properties / nexus_owner_*; an account reaches
-- them only through nexus_owner_links.nexus_account_ref ('sync:<public_id>') and
-- the existing claim -> staff verification flow.
BEGIN;

CREATE TABLE IF NOT EXISTS sync_accounts (
  id                  BIGSERIAL PRIMARY KEY,
  public_id           UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  email               TEXT UNIQUE,
  email_verified_at   TIMESTAMPTZ,
  password_hash       TEXT,
  display_name        TEXT,
  phone_e164          TEXT,
  phone_verified_at   TIMESTAMPTZ,
  phone_verified_via  TEXT,
  notify_channel      TEXT NOT NULL DEFAULT 'whatsapp' CHECK (notify_channel IN ('whatsapp','sms','email','app')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at         TIMESTAMPTZ,
  CHECK (email IS NULL OR email = lower(email))
);
-- one account per confirmed mobile number
CREATE UNIQUE INDEX IF NOT EXISTS sync_accounts_phone_verified ON sync_accounts (phone_e164) WHERE phone_verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS sync_identities (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES sync_accounts(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('facebook','google','apple')),
  provider_uid  TEXT NOT NULL,
  email         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_uid)
);

CREATE TABLE IF NOT EXISTS sync_sessions (
  token_hash    TEXT PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES sync_accounts(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS sync_sessions_account ON sync_sessions (account_id);

-- e-mail codes, WhatsApp tokens and SMS codes; stored hashed, single use
CREATE TABLE IF NOT EXISTS sync_checks (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES sync_accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('email','phone_whatsapp','phone_sms')),
  target        TEXT,
  code_hash     TEXT NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NOT NULL,
  verified_at   TIMESTAMPTZ,
  sender        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sync_checks_open ON sync_checks (kind, code_hash) WHERE verified_at IS NULL;
CREATE INDEX IF NOT EXISTS sync_checks_account ON sync_checks (account_id, created_at DESC);

-- Owner <-> ARGUS conversation from SYNC. Part of the nexus_owner_* family.
-- Kept apart from owner_contact_log on purpose: that table is outreach
-- accounting (daily quotas, last touch, recheck cadence) and must not count
-- a message the owner wrote in SYNC.
CREATE TABLE IF NOT EXISTS nexus_owner_messages (
  id               BIGSERIAL PRIMARY KEY,
  agency_key       TEXT NOT NULL,
  account_id       BIGINT NOT NULL REFERENCES sync_accounts(id) ON DELETE CASCADE,
  owner_link_id    BIGINT REFERENCES nexus_owner_links(id),
  property_id      INT,
  direction        TEXT NOT NULL CHECK (direction IN ('in','out')),
  sender_kind      TEXT NOT NULL CHECK (sender_kind IN ('owner','agent','system')),
  agent_id         INT,
  sender_name      TEXT,
  sender_org       TEXT,
  body             TEXT NOT NULL,
  attachment       JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_by_staff_at TIMESTAMPTZ,
  read_by_owner_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS nexus_owner_messages_thread ON nexus_owner_messages (agency_key, account_id, id);
CREATE INDEX IF NOT EXISTS nexus_owner_messages_unread ON nexus_owner_messages (agency_key, id) WHERE direction='in' AND read_by_staff_at IS NULL;

COMMIT;
