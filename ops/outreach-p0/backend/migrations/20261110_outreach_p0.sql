-- 20261110_outreach_p0.sql — ARGUS Outreach P0 (Claude, 2026-11-10).
-- Additive, idempotent. Requires 20261109_outreach_planner_v2.sql.
-- 1. Manual pause, separate from Auto ON/OFF (gray "Manually paused").
-- 2. Persona introductions: three approved, multi-paragraph variants per
--    persona (slots 5–7) with the verified affiliation only (Kevin: 2906;
--    Cedric: QuickLets; Gabriela: no company named). The one-line legacy
--    slots 1–4 become INACTIVE (kept, never deleted) — rotation then uses only
--    the paragraph variants. Greeting is still chosen at send time (Malta).
BEGIN;

ALTER TABLE outreach_automation_configs
  ADD COLUMN IF NOT EXISTS manual_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manual_paused_by TEXT,
  ADD COLUMN IF NOT EXISTS manual_pause_reason TEXT;

UPDATE outreach_persona_templates SET status = 'inactive', active = FALSE, updated_by = 'outreach-p0-20261110', updated_at = NOW()
 WHERE persona IN ('kev', 'cedric', 'gabriela') AND slot BETWEEN 1 AND 4 AND status <> 'inactive';

UPDATE outreach_persona_templates SET status = 'approved', active = TRUE, approved_by = 'founder-brief-2026-11-10', approved_at = NOW(), updated_by = 'outreach-p0-20261110'
 WHERE persona IN ('kev', 'cedric') AND slot = 5 AND status = 'draft';

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
   E'{G},\n\nMy name is Gabriela. I assist clients who are looking for residential properties in Malta.\n\nI would be grateful to know whether you have any apartments available for long let, now or expected soon.\n\nIf you have something suitable, feel free to share the locality, asking price and availability date. Thank you.\n\nGabriela'),
  ('gabriela', 7, 'Gabriela — Short introduction',
   E'{G},\n\nThis is Gabriela, a real estate agent in Malta. I''m currently helping a few clients who are looking to rent or buy.\n\nDo you have a property available at the moment, or anything coming onto the market in the next few weeks?\n\nThank you for your time, and {C}.\n\nKind regards,\nGabriela')
)
INSERT INTO outreach_persona_templates(persona, period, slot, body, active, status, purpose, title, updated_by, approved_by, approved_at)
SELECT b.persona, p.period, b.slot, replace(replace(b.body, '{G}', p.greeting), '{C}', p.closing), TRUE, 'approved', 'first_contact', b.title,
       'outreach-p0-20261110', 'founder-brief-2026-11-10', NOW()
  FROM bodies b CROSS JOIN periods p
ON CONFLICT (persona, period, slot) DO NOTHING;

COMMIT;
