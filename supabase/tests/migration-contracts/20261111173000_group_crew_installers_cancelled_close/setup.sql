-- The registered stack supplies the group tables, the one crew population
-- (with the office removal of 20261106170000) and the tables the close reads.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_crew(uuid[])') IS NULL
     OR to_regprocedure('public.remove_group_work_order_participant(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.group_work_order_lock_job(uuid)') IS NULL
     OR to_regclass('public.group_work_order_crew_removals') IS NULL
     OR to_regclass('public.group_work_order_releases') IS NULL
     OR to_regclass('public.group_work_order_signatures') IS NULL
     OR to_regclass('public.job_client_signoffs') IS NULL THEN
    RAISE EXCEPTION 'group crew roles prerequisites are missing';
  END IF;
END $$;
