-- After 20261029170000_cfo_bill_cost_outcomes_down.sql: the outcome view is
-- gone and the engine it reads is untouched and queryable.
DO $$
BEGIN
  IF to_regclass('public.cfo_bill_cost_outcomes') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left cfo_bill_cost_outcomes';
  END IF;
  PERFORM 1 FROM public.v_job_cost_events LIMIT 1;
  PERFORM 1 FROM public.v_job_profit LIMIT 1;
  PERFORM 1 FROM public.v_bill_allocation_balance LIMIT 1;
END $$;
