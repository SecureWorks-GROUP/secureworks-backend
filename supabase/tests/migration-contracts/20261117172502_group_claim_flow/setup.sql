-- The registered group stack, including P1-13.1, supplies the projection.
DO $$ BEGIN
  IF to_regprocedure('public.project_group_work_order_split(uuid)') IS NULL
     OR to_regclass('public.group_work_order_events') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST group claim prerequisites missing';
  END IF;
END $$;
