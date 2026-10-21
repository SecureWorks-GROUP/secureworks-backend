-- After the down migration the function is gone and the 1107 and H7 bodies
-- are back (any person source with a non-blank actor reads as a person).
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regprocedure('public.cfo_recorded_person(text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'recorded person rollback: function survived';
  END IF;
  IF to_regclass('public.cfo_bill_reconciliation_outcomes') IS NULL
     OR to_regclass('public.v_bill_allocation_balance') IS NULL
     OR to_regclass('public.v_job_cost_events') IS NULL
     OR to_regclass('public.v_job_profit') IS NULL THEN
    RAISE EXCEPTION 'recorded person rollback: a view was lost';
  END IF;
  IF position('bool_or' IN pg_get_viewdef('public.v_bill_allocation_balance'::regclass)) = 0
     OR position('ops_dashboard' IN pg_get_viewdef('public.cfo_bill_reconciliation_outcomes'::regclass)) = 0
     OR position('actor required' IN pg_get_functiondef('public.allocate_bill_split(text, jsonb, numeric, text, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'recorded person rollback: the 1107 or H7 body was not restored';
  END IF;
END $$;
