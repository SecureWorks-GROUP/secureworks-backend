-- The registered stack supplies the group tables, the hours guard and the split.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_write_split(uuid,boolean)') IS NULL
     OR to_regprocedure('public.group_work_order_time_entries_guard()') IS NULL
     OR to_regclass('public.group_work_order_events') IS NULL THEN
    RAISE EXCEPTION 'group self opt-in prerequisites are missing';
  END IF;
END $$;
