-- 20261029_outreach_automation.sql — ARGUS outreach automation rebuild (Kev, 2026-10-29).
-- Additive and idempotent. Reverse with 20261029_outreach_automation.down.sql.
BEGIN;

-- 1. Pace (the CRM "PACE" control = outreach_volume_percent, 10–100; dispatch
--    delay multiplier = 100 / pace). A saved pace is now a persistent range.
ALTER TABLE whatsapp_accounts
  ADD COLUMN IF NOT EXISTS outreach_pace_min INTEGER,
  ADD COLUMN IF NOT EXISTS outreach_pace_max INTEGER,
  ADD COLUMN IF NOT EXISTS outreach_auto_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS outreach_auto_rolling BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS outreach_auto_horizon_days INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS outreach_daily_target_min INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS outreach_daily_target_max INTEGER NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS outreach_auto_updated_at TIMESTAMPTZ;

-- Bug fix data repair: an expired temporary override used to be READ as 100
-- while the saved value stayed in the column (Argus2/Gabriela saved 33,
-- sent at 100 since 2026-09-29). Clear the expiry and keep the saved value.
UPDATE whatsapp_accounts
   SET outreach_volume_until = NULL
 WHERE outreach_volume_until IS NOT NULL AND outreach_volume_until <= NOW();

UPDATE whatsapp_accounts
   SET outreach_pace_min = COALESCE(outreach_pace_min, outreach_volume_percent, 100),
       outreach_pace_max = COALESCE(outreach_pace_max, outreach_volume_percent, 100)
 WHERE outreach_pace_min IS NULL OR outreach_pace_max IS NULL;

DO $$ BEGIN
  ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_outreach_pace_range
    CHECK (outreach_pace_min IS NULL OR (outreach_pace_min BETWEEN 10 AND 100
           AND outreach_pace_max BETWEEN 10 AND 100 AND outreach_pace_min <= outreach_pace_max));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_outreach_daily_target
    CHECK (outreach_daily_target_min BETWEEN 1 AND 40 AND outreach_daily_target_max BETWEEN 1 AND 40
           AND outreach_daily_target_min <= outreach_daily_target_max);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Plans remember whether their text is free text or a persona-library slot
--    rendered at send time.
ALTER TABLE outreach_plans
  ADD COLUMN IF NOT EXISTS message_mode TEXT NOT NULL DEFAULT 'free_text',
  ADD COLUMN IF NOT EXISTS template_slot INTEGER,
  ADD COLUMN IF NOT EXISTS saved_all_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE outreach_plans ADD CONSTRAINT outreach_plans_message_mode
    CHECK (message_mode IN ('free_text', 'persona_rotation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Persona template library (editable in the CRM, seeded below) and the
--    per-account rotation history.
CREATE TABLE IF NOT EXISTS outreach_persona_templates (
  id SERIAL PRIMARY KEY,
  persona TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('morning', 'afternoon', 'evening')),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 12),
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 20 AND 1200),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (persona, period, slot)
);

CREATE TABLE IF NOT EXISTS outreach_template_usage (
  id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  slot INTEGER NOT NULL,
  plan_id INTEGER UNIQUE REFERENCES outreach_plans(id) ON DELETE SET NULL,
  used_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outreach_template_usage_account
  ON outreach_template_usage(account_id, used_on DESC, id DESC);

-- 4. Hard daily cap: max 40 unique recipients per account per Malta day.
CREATE TABLE IF NOT EXISTS outreach_daily_quota (
  account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  malta_date DATE NOT NULL,
  target INTEGER NOT NULL CHECK (target BETWEEN 1 AND 40),
  cap INTEGER NOT NULL DEFAULT 40 CHECK (cap BETWEEN 1 AND 40),
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, malta_date),
  CHECK (used >= 0 AND used <= cap)
);

CREATE TABLE IF NOT EXISTS outreach_daily_recipients (
  account_id INTEGER NOT NULL,
  malta_date DATE NOT NULL,
  phone TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'sent')),
  run_id TEXT,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, malta_date, phone),
  FOREIGN KEY (account_id, malta_date) REFERENCES outreach_daily_quota(account_id, malta_date) ON DELETE CASCADE
);

-- 5. Operator-editable thresholds (engagement / call candidates).
CREATE TABLE IF NOT EXISTS outreach_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO outreach_settings(key, value) VALUES
  ('engagement.no_reply_review_after', '5'::jsonb),
  ('engagement.call_candidate_min_attempts', '3'::jsonb),
  ('engagement.report_thresholds', '[1,3,5,6,7]'::jsonb),
  ('dispatch.cross_account_days', '20'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Seed: 36 persona templates (services/outreachTemplateSeed.js). Existing
-- rows are never overwritten, so CRM edits survive re-running this file.
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'morning', 1, 'Good morning! Kevin here. I''m currently assisting several clients looking for properties to rent or purchase across Malta. If you have anything available or coming onto the market soon, I''d be happy to hear from you. Have a lovely day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'morning', 2, 'Good morning, I hope your day is off to a good start. My name is Kevin and I work with clients who are looking to rent or buy property in Malta. Do you have anything available at the moment, or something coming up in the next few weeks? Have a great day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'morning', 3, 'Good morning! This is Kevin. I help property owners find suitable tenants and buyers, and I currently have clients searching for rentals and homes to purchase. If you have a property available or soon to be, I''d be glad to help market it. Have a lovely day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'morning', 4, 'Good morning! Kevin here, I hope all is well. I''m reaching out to owners who may have a rental or a property for sale coming up. If that''s the case for you, feel free to send me the details and I''ll let you know if it suits any of the clients I''m working with. Have a good day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'afternoon', 1, 'Good afternoon, hope your day is going well! I''m reaching out as I''m working with clients actively searching for rental and sales opportunities. Feel free to share any available or upcoming properties, and I''d be happy to assist.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'afternoon', 2, 'Good afternoon! Kevin here. I''m currently helping clients who are looking to rent or buy in Malta, and I wanted to ask whether you have any properties available now or coming up soon. I''d be happy to hear from you.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'afternoon', 3, 'Good afternoon, I hope you''re having a good day. This is Kevin, I work with tenants and buyers searching for property across Malta. If you have something available or expected shortly, just send me the details and I''ll see if it''s a good match.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'afternoon', 4, 'Good afternoon! Just a short message from Kevin. If you have a property for rent or sale, now or in the near future, I''d be glad to help with marketing it and finding suitable tenants or buyers. Have a lovely afternoon!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'evening', 1, 'Good evening! Just a quick message from Kevin. I''m currently helping clients with property searches across Malta and would be glad to hear about any properties you have available or coming up soon. Wishing you a pleasant evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'evening', 2, 'Good evening, I hope you''ve had a good day. Kevin here, I''m working with clients looking for rentals and properties to buy in Malta. If you have anything available or coming onto the market, I''d be happy to hear about it. Enjoy your evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'evening', 3, 'Good evening! This is Kevin. I help owners find the right tenants and buyers for their properties. If you have something available or opening up soon, feel free to share the details and I''ll get back to you. Have a pleasant evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('kev', 'evening', 4, 'Good evening! Kevin here with a short question: do you currently have, or expect to have, a property for rent or sale in Malta? I''m assisting several clients with their search and would be glad to help. Have a lovely evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'morning', 1, 'Good morning! This is Cedric. I''m working with clients who are currently looking for suitable rental and purchase opportunities in Malta. Please feel free to let me know if you have any properties available or expected soon.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'morning', 2, 'Good morning, I hope you''re well. Cedric here. I''m assisting clients who are looking to rent or buy property in Malta, and I''d be glad to know if you have anything available or coming up. Have a good day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'morning', 3, 'Good morning! My name is Cedric and I help match property owners with suitable tenants and buyers. If you have a property available now or in the coming weeks, I''d be happy to hear about it. Have a nice day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'morning', 4, 'Good morning! Cedric here. I''m reaching out to owners who may have a rental or sale property coming up. If that applies to you, feel free to send me the details and I''ll check whether it fits the clients I''m working with. Have a great day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'afternoon', 1, 'Good afternoon! I hope everything is going well. I''m currently assisting clients with their property search and wanted to check whether you have any new or upcoming listings. I''d be happy to help find suitable matches.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'afternoon', 2, 'Good afternoon! This is Cedric. I''m working with clients looking for rentals and properties to buy across Malta. Do you have anything available at the moment or expected soon? I''d be glad to hear from you.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'afternoon', 3, 'Good afternoon, I hope your day is going well. Cedric here, I help owners market their properties and find suitable tenants or buyers. If you have something available or coming up, just let me know.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'afternoon', 4, 'Good afternoon! A short message from Cedric. If you have a property for rent or sale now or in the near future, feel free to share the details. I''d be happy to see whether it suits any of my clients. Have a nice afternoon!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'evening', 1, 'Good evening! Cedric here. If you have any properties available for rent or sale, or anything becoming available shortly, I''d be happy to assist with finding suitable clients. Enjoy your evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'evening', 2, 'Good evening, I hope you''ve had a good day. This is Cedric, I''m assisting clients who are searching for rentals and homes to buy in Malta. If you have anything available or coming up soon, I''d be glad to hear about it. Have a pleasant evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'evening', 3, 'Good evening! Cedric here. I help property owners find the right tenants and buyers. If you have a property available now or in the coming weeks, feel free to send me the details. Wishing you a lovely evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('cedric', 'evening', 4, 'Good evening! This is Cedric with a quick question: do you have a property for rent or sale in Malta, or one coming up soon? I''d be happy to help with finding suitable clients. Enjoy your evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'morning', 1, 'Good morning! Gabriela here. I''m currently working with clients looking for homes and investment opportunities in Malta. I''d love to hear if you have any properties available now or coming up soon. Have a wonderful day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'morning', 2, 'Good morning, I hope your day has started well! This is Gabriela. I''m helping clients who want to rent or buy property in Malta, and I''d be happy to know if you have anything available or coming up soon. Have a lovely day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'morning', 3, 'Good morning! My name is Gabriela and I help owners find suitable tenants and buyers. If you have a property available now or in the coming weeks, I''d be glad to help with marketing it. Have a beautiful day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'morning', 4, 'Good morning! Gabriela here. I''m reaching out to owners who may have a rental or property for sale coming up. If that''s you, feel free to share the details and I''ll let you know whether it suits my clients. Have a great day!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'afternoon', 1, 'Good afternoon, hope you''re having a lovely day! I''m helping clients find suitable rental and sales properties and wanted to ask whether you have anything currently available or expected in the near future.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'afternoon', 2, 'Good afternoon! Gabriela here. I''m working with clients looking for homes to rent or buy across Malta. Do you have anything available at the moment or coming up soon? I''d love to hear from you.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'afternoon', 3, 'Good afternoon, I hope all is well! This is Gabriela, I help property owners market their homes and find suitable tenants or buyers. If you have something available or expected shortly, just let me know.', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'afternoon', 4, 'Good afternoon! A quick message from Gabriela. If you have a property for rent or sale now or in the near future, feel free to send me the details and I''ll see whether it matches any of my clients. Have a lovely afternoon!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'evening', 1, 'Good evening! This is Gabriela. I''m currently assisting clients with their property search and would be happy to help with any available or upcoming rental or sales listings. Wishing you a lovely evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'evening', 2, 'Good evening, I hope you''ve had a lovely day! Gabriela here. I''m helping clients who are looking for homes and investment properties in Malta. If you have anything available or coming up soon, I''d be glad to hear about it. Enjoy your evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'evening', 3, 'Good evening! This is Gabriela. I help owners find the right tenants and buyers for their properties. If you have something available now or soon, feel free to share the details. Have a pleasant evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;
INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by) VALUES ('gabriela', 'evening', 4, 'Good evening! Gabriela here with a short question: do you have a property for rent or sale in Malta, now or coming up soon? I''d be happy to help find suitable clients. Have a lovely evening!', 'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING;

COMMIT;
