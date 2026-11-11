-- After the down file: any non-admin booking adds a person again, and the
-- automatic close is gone. A group it closed stays void.
DO $$
DECLARE body text := pg_get_functiondef('public.group_work_order_crew(uuid[])'::regprocedure);
BEGIN
  IF to_regprocedure('public.close_group_work_orders_on_cancelled_jobs()') IS NOT NULL THEN
    RAISE EXCEPTION 'crew-roles rollback: the automatic close remains';
  END IF;
  IF strpos(body, '(20261111173000)') > 0
     OR strpos(body, $t$AND lower(COALESCE(u.role::text, '')) <> 'admin'$t$) = 0
     OR strpos(body, '(20261106170000)') = 0 THEN
    RAISE EXCEPTION 'crew-roles rollback: the earlier crew rule was not restored';
  END IF;
END $$;
