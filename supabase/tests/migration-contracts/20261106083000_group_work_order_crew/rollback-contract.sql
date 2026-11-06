DO $$ BEGIN
 IF to_regprocedure('public.group_work_order_crew(uuid[])') IS NOT NULL THEN RAISE EXCEPTION 'group-crew rollback: helper remains'; END IF;
 IF pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure)
 IS DISTINCT FROM (SELECT body FROM public.migration_contract_group_crew_before) THEN
  RAISE EXCEPTION 'group-crew rollback: predecessor not restored';
 END IF;
END $$;
