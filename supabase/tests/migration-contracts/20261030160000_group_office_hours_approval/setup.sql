-- The registered stack supplies the group, events and lock surfaces.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_lock_job(uuid)') IS NULL
     OR to_regprocedure('public.freeze_group_work_order_split(uuid)') IS NULL
     OR to_regclass('public.group_work_order_events') IS NULL THEN
    RAISE EXCEPTION 'group office hours approval prerequisites are missing';
  END IF;
END $$;
