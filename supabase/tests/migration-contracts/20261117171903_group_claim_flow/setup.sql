DO $$ BEGIN
  IF to_regprocedure('public.project_group_work_order_split(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST group projection prerequisite missing';
  END IF;
END $$;
