DO $$ BEGIN
  IF pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure) NOT LIKE '%AND wo.agreed_labour_ex > 0%' THEN
    RAISE EXCEPTION 'ZZTEST split gate rollback incomplete'; END IF;
END $$;
