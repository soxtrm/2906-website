-- 20261110_owner_ai_recal.sql — ARGUS Owner AI recalibration (Claude, 2026-11-10).
-- Additive and idempotent. Nothing here sends, enables or approves anything.
BEGIN;

-- 0. Live-schema repair: conversationIntelligence (deployed 2026-11-10 14:20 UTC)
--    reads properties.floor_level; migration 20261031_scorecard_fields was never
--    applied, so every inbound since then failed with "column floor_level does
--    not exist". Same idempotent columns as that migration.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS floor_level  TEXT,
  ADD COLUMN IF NOT EXISTS parking_type TEXT;

-- 1. One audit row per owner turn handled by the decision layer (redacted).
CREATE TABLE IF NOT EXISTS owner_ai_decisions (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  conversation_id  BIGINT,
  phone_hash       TEXT,
  phone_last4      TEXT,
  session          TEXT,
  persona          TEXT,
  inbound_redacted TEXT,
  next_action      TEXT NOT NULL,
  reason_code      TEXT NOT NULL,
  fact_mutations   JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_reply      TEXT,
  send_eligible    BOOLEAN NOT NULL DEFAULT FALSE,
  sent             BOOLEAN NOT NULL DEFAULT FALSE,
  block_reason     TEXT,
  policy_version   TEXT NOT NULL,
  release          TEXT,
  intent           TEXT,
  legacy_path      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS owner_ai_decisions_created_idx ON owner_ai_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS owner_ai_decisions_conv_idx ON owner_ai_decisions (conversation_id, created_at DESC);

-- 2. Weekly quality reports: immutable once written (no UPDATE path in code).
CREATE TABLE IF NOT EXISTS owner_ai_quality_reports (
  id               UUID PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger          TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  created_by       TEXT,
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  timezone         TEXT NOT NULL DEFAULT 'Europe/Malta',
  report           JSONB NOT NULL,
  digest           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_ai_quality_reports_created_idx ON owner_ai_quality_reports (created_at DESC);

-- 3. Founder review of report cases: Approve / Correct / Block. Append-only.
CREATE TABLE IF NOT EXISTS owner_ai_quality_reviews (
  id                BIGSERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  report_id         UUID NOT NULL REFERENCES owner_ai_quality_reports(id),
  case_id           TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('approve', 'correct', 'block')),
  corrected_action  TEXT,
  corrected_reply   TEXT,
  note              TEXT,
  reviewer          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_ai_quality_reviews_case_idx ON owner_ai_quality_reviews (report_id, case_id, created_at DESC);

-- 4. Approved corrections become immutable regression fixture candidates for
--    the NEXT release (never a live prompt/policy change).
CREATE TABLE IF NOT EXISTS owner_ai_fixture_candidates (
  id                BIGSERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  review_id         BIGINT NOT NULL REFERENCES owner_ai_quality_reviews(id),
  fixture           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending_release' CHECK (status IN ('pending_release', 'included', 'rejected'))
);

-- 5. Immediate P0 quality incidents (do not wait for Monday).
CREATE TABLE IF NOT EXISTS owner_ai_quality_incidents (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity         TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
  kind             TEXT NOT NULL,
  conversation_id  BIGINT,
  session          TEXT,
  detail           TEXT,
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT,
  case_key         TEXT UNIQUE
);

-- 6. Regression results recorded by each verified release.
CREATE TABLE IF NOT EXISTS owner_ai_regression_runs (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  release          TEXT NOT NULL,
  policy_version   TEXT NOT NULL,
  code_hash        TEXT NOT NULL,
  results          JSONB NOT NULL
);

-- 7. Persisted schedule (survives restarts): Monday 08:30 Europe/Malta.
CREATE TABLE IF NOT EXISTS owner_ai_quality_schedule (
  id               TEXT PRIMARY KEY,
  cron             TEXT NOT NULL,
  timezone         TEXT NOT NULL,
  next_run_at      TIMESTAMPTZ NOT NULL,
  last_run_at      TIMESTAMPTZ,
  last_report_id   UUID,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- First run: Monday 16 Nov 2026 08:30 Europe/Malta (CET, UTC+1) = 07:30 UTC.
INSERT INTO owner_ai_quality_schedule (id, cron, timezone, next_run_at)
VALUES ('weekly_owner_ai', 'MON 08:30', 'Europe/Malta', '2026-11-16 07:30:00+00')
ON CONFLICT (id) DO NOTHING;

COMMIT;
