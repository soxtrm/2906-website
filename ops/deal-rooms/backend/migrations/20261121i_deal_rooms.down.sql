-- Rollback of 20261121i_deal_rooms: refuses when any Deal Room exists (never drops data).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'deal_rooms') AND EXISTS (SELECT 1 FROM deal_rooms) THEN
    RAISE EXCEPTION 'deal_rooms has rows: not dropping (keep the tables, roll back the code only)';
  END IF;
END $$;
DROP TABLE IF EXISTS deal_room_events;
DROP TABLE IF EXISTS deal_rooms;
