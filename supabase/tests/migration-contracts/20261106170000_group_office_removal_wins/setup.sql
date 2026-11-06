-- The registered stack supplies the group tables, the one crew population
-- (with the paid-by-hours change) and the office removal this amends.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_crew(uuid[])') IS NULL
     OR to_regprocedure('public.remove_group_work_order_participant(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.group_work_order_paid_by_hours(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'group office removal prerequisites are missing';
  END IF;
END $$;
