-- 20261110_outreach_p0.sql — ARGUS Outreach P0 (Claude, 2026-11-10).
-- Additive, idempotent. Requires 20261109_outreach_planner_v2.sql.
-- 1. Manual pause, separate from Auto ON/OFF (gray "Manually paused").
-- 2. Persona introductions (slots 6–7) stored as DRAFT for founder review.
--    Founder decision 2026-11-10: nothing is approved by migration; the live
--    rotation (approved slots) is left exactly as it is until replacements are
--    approved in the Templates tab.
BEGIN;

ALTER TABLE outreach_automation_configs
  ADD COLUMN IF NOT EXISTS manual_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manual_paused_by TEXT,
  ADD COLUMN IF NOT EXISTS manual_pause_reason TEXT;

-- True zero: a saved daily target of 0 means "no outreach". The existing check
-- required >= 1, so 0 could not be stored at all. Superset: 0–40, min <= max.
ALTER TABLE whatsapp_accounts DROP CONSTRAINT IF EXISTS whatsapp_accounts_outreach_daily_target;
ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_outreach_daily_target
  CHECK (outreach_daily_target_min BETWEEN 0 AND 40 AND outreach_daily_target_max BETWEEN 0 AND 40 AND outreach_daily_target_min <= outreach_daily_target_max);

WITH periods(period, greeting, closing) AS (
  VALUES ('morning', 'Good morning', 'have a lovely day'), ('afternoon', 'Good afternoon', 'have a lovely afternoon'), ('evening', 'Good evening', 'have a lovely evening')
), bodies(persona, slot, title, body) AS (
  VALUES
  ('kev', 6, 'Kevin — Availability update',
   E'{G},\n\nMy name is Kevin. I''m a real estate consultant with the 2906 independent-agent collective, focusing on residential rentals and sales in Malta.\n\nI''m currently updating my list of available and upcoming properties for clients who are actively looking.\n\nWould you have any apartments available now or becoming available soon? If so, I''d be happy to hear the area, asking price and available-from date.\n\nKind regards,\nKevin'),
  ('kev', 7, 'Kevin — Short introduction',
   E'{G},\n\nThis is Kevin from 2906 Estate. I work with tenants and buyers who are looking for homes in Malta.\n\nDo you have a property for rent or sale at the moment, or one that will become available in the coming weeks?\n\nThank you, and {C}.\n\nKevin'),
  ('cedric', 6, 'Cedric — Long-let availability',
   E'{G},\n\nI''m Cedric, a real estate consultant with QuickLets. I help clients find suitable residential rentals in Malta.\n\nI''m contacting you about possible upcoming availability in your area. Would you have a property becoming available for long let?\n\nThank you, and {C}.\n\nCedric'),
  ('cedric', 7, 'Cedric — Client-led introduction',
   E'{G},\n\nMy name is Cedric, and I work as a rental agent with QuickLets in Malta.\n\nSome of my clients are looking for long-let apartments at the moment. Do you have anything available now, or coming up soon?\n\nIf so, the locality, monthly rent and available-from date would be a great start.\n\nKind regards,\nCedric'),
  ('gabriela', 6, 'Gabriela — Long-let availability',
   E'{G},\n\nMy name is Gabriela. I assist clients who are looking for residential properties in Malta.\n\nWould you have any apartments available for long let, now or expected soon?\n\nIf you have something suitable, feel free to share the locality, asking price and availability date. Thank you.\n\nGabriela'),
  ('gabriela', 7, 'Gabriela — Short introduction',
   E'{G},\n\nThis is Gabriela, a real estate agent in Malta. I''m currently helping a few clients who are looking to rent or buy.\n\nDo you have a property available at the moment, or anything coming onto the market in the next few weeks?\n\nThank you for your time, and {C}.\n\nKind regards,\nGabriela')
)
INSERT INTO outreach_persona_templates(persona, period, slot, body, active, status, purpose, title, updated_by, approved_by, approved_at)
SELECT b.persona, p.period, b.slot, replace(replace(b.body, '{G}', p.greeting), '{C}', p.closing), TRUE, 'draft', 'first_contact', b.title,
       'outreach-p0-20261110', NULL, NULL
  FROM bodies b CROSS JOIN periods p
ON CONFLICT (persona, period, slot) DO UPDATE SET body = EXCLUDED.body, title = EXCLUDED.title, updated_at = NOW()
  WHERE outreach_persona_templates.status = 'draft' AND outreach_persona_templates.updated_by = 'outreach-p0-20261110';

COMMIT;
