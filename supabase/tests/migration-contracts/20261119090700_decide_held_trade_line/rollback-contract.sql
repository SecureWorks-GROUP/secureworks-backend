DO $$ BEGIN
  IF to_regprocedure('public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'held_line_rollback_failed';
  END IF;
END $$;
