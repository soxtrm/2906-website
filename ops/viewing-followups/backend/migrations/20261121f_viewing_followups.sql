-- ARGUS viewing request follow-up (Claude, 2026-11-21). Additive only.
-- One row per booking request (property_viewings.id), created as soon as the
-- request exists, whether or not the owner has answered. The question to the
-- agent ("did it take place?") is asked once, the day after the slot.
BEGIN;

CREATE TABLE IF NOT EXISTS viewing_followups (
  id                   SERIAL PRIMARY KEY,
  viewing_id           INT NOT NULL UNIQUE REFERENCES property_viewings(id) ON DELETE CASCADE,
  property_id          INT NOT NULL,
  requesting_agent_id  INT,
  slot_at              TIMESTAMPTZ NOT NULL,      -- the booking's time, kept in step with property_viewings.starts_at
  agent_slot_at        TIMESTAMPTZ,               -- a new time the agent reported ("rescheduled"); cleared when the booking itself moves
  slot_tz              TEXT NOT NULL DEFAULT 'Europe/Malta',
  request_channel      TEXT,
  state                TEXT NOT NULL DEFAULT 'requested'
                       CHECK (state IN ('requested','confirmed','rescheduled','cancelled','completed','no_show','unverified')),
  feedback_state       TEXT NOT NULL DEFAULT 'scheduled'
                       CHECK (feedback_state IN ('scheduled','due','asked','answered','cancelled')),
  due_date             DATE NOT NULL,
  ask_after            TIMESTAMPTZ NOT NULL,
  ask_key              TEXT,
  asked_at             TIMESTAMPTZ,
  ask_count            INT NOT NULL DEFAULT 0,
  outcome              TEXT CHECK (outcome IN ('completed','didnt_happen','rescheduled','awaiting')),
  next_step            TEXT CHECK (next_step IN ('interested','follow_up','offer','declined','none')),
  answer_note          TEXT,
  answered_by          INT,
  answered_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS viewing_followups_ask_key ON viewing_followups (ask_key) WHERE ask_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS viewing_followups_due ON viewing_followups (feedback_state, ask_after);
CREATE INDEX IF NOT EXISTS viewing_followups_agent ON viewing_followups (requesting_agent_id, due_date);

-- Timeline: every state change, question, answer and owner-contact access.
CREATE TABLE IF NOT EXISTS viewing_followup_events (
  id           SERIAL PRIMARY KEY,
  followup_id  INT NOT NULL REFERENCES viewing_followups(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  agent_id     INT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS viewing_followup_events_f ON viewing_followup_events (followup_id, at);

-- Who may open an owner's contact details from a booking request.
-- Granted explicitly per agent (initially Olga and Katya); never implied by any other role flag.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS can_view_owner_contact BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
