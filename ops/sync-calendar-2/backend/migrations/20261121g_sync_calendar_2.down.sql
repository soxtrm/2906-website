-- Back to the previous allowed values; refuses while owner appointments exist (nothing is deleted).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM property_viewings WHERE source = 'owner_sync') THEN
    RAISE EXCEPTION 'owner_sync viewings exist; keep the wider check (nothing deleted)';
  END IF;
END $$;
ALTER TABLE property_viewings DROP CONSTRAINT IF EXISTS property_viewings_source_check,
  ADD CONSTRAINT property_viewings_source_check CHECK (source = ANY (ARRAY['admin_book'::text, 'agent_book'::text, 'client_book'::text, 'cron'::text, 'board_slot'::text]));
