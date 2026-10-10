ALTER TABLE whatsapp_accounts
  ADD COLUMN IF NOT EXISTS outreach_auto_base_count INTEGER,
  ADD COLUMN IF NOT EXISTS outreach_auto_message TEXT;

ALTER TABLE whatsapp_accounts
  DROP CONSTRAINT IF EXISTS whatsapp_accounts_outreach_auto_base_count_check;

ALTER TABLE whatsapp_accounts
  ADD CONSTRAINT whatsapp_accounts_outreach_auto_base_count_check
  CHECK (outreach_auto_base_count IS NULL OR outreach_auto_base_count BETWEEN 1 AND 45);
