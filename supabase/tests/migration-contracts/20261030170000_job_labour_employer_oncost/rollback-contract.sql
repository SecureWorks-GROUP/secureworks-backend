-- After the down: the views read as 20261028173000 and 20261015093000 left them.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF pg_get_viewdef('public.v_job_cost_events'::regclass) LIKE '%trade_employer_super%' THEN
    RAISE EXCEPTION 'rollback: employer super still a source';
  END IF;
  IF pg_get_viewdef('public.v_trade_charge_resolved'::regclass) LIKE '%group share%'
     OR pg_get_viewdef('public.v_trade_charge_resolved'::regclass) LIKE '%advance%' THEN
    RAISE EXCEPTION 'rollback: resolver still has the new lanes';
  END IF;
  IF pg_get_viewdef('public.v_job_cost_events'::regclass) NOT LIKE '%agent_ai%' THEN
    RAISE EXCEPTION 'rollback: v_job_cost_events is not the 20261028173000 view';
  END IF;
  PERFORM 1 FROM public.v_job_profit LIMIT 1;
  IF has_table_privilege('anon', 'public.v_job_cost_events', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_cost_events', 'SELECT') THEN
    RAISE EXCEPTION 'rollback: grants changed';
  END IF;
END $$;
