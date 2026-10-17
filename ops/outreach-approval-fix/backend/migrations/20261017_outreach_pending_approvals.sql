-- Durable YES/EDIT/STOP approvals for notes-chat !outreach (2026-10-17).
-- Until now the pending approval lived only in process memory: a backend
-- restart inside the 5-minute window silently dropped it. One row per
-- preview; the YES transition PENDING -> APPROVED is a single conditional
-- UPDATE, so only one handler (or one instance) can ever enqueue the run.
BEGIN;

CREATE TABLE IF NOT EXISTS outreach_pending_approvals (
  approval_id        UUID PRIMARY KEY,
  admin_phone        TEXT NOT NULL,
  reply_session      TEXT NOT NULL,
  sending_session    TEXT NOT NULL,
  list_type          TEXT,
  contacts           JSONB NOT NULL,
  message_template   TEXT NOT NULL,
  from_notes_chat    BOOLEAN NOT NULL DEFAULT TRUE,
  preview_message_id TEXT,
  state              TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (state IN ('PENDING','APPROVED','CANCELLED','EXPIRED','SUPERSEDED','REFUSED')),
  run_id             UUID,
  refusal_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  decided_at         TIMESTAMPTZ
);

-- At most one actionable preview per operator.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_pending_approvals_one_pending
  ON outreach_pending_approvals (admin_phone) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS outreach_pending_approvals_recent
  ON outreach_pending_approvals (admin_phone, decided_at DESC NULLS LAST);

COMMIT;
