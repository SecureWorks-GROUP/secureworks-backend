DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_write_split(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'group split prerequisites are missing';
  END IF;
END $$;
