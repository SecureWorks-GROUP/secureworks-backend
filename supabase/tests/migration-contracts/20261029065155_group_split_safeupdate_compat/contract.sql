DO $$ BEGIN
  IF strpos(pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure), 'WHERE points_micro > 0') = 0 THEN
    RAISE EXCEPTION 'split remainder update lost its safe-update WHERE clause';
  END IF;
END $$;
SELECT 'PASS: split remainder update carries a WHERE clause' AS result;
