-- After the down migration: the engine is gone and the legacy sources it read
-- are still queryable.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.v_job_profit') IS NOT NULL
     OR to_regclass('public.v_job_cost_events') IS NOT NULL
     OR to_regclass('public.v_job_revenue_events') IS NOT NULL THEN
    RAISE EXCEPTION 'jp rollback: an engine view survived the down migration';
  END IF;
  IF to_regprocedure('public.job_profit(uuid)') IS NOT NULL OR to_regprocedure('public.job_profit_num(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'jp rollback: an engine function survived the down migration';
  END IF;
  PERFORM 1 FROM public.v_trade_charge_resolved LIMIT 1;
  PERFORM 1 FROM public.v_invoice_line_completeness LIMIT 1;
  PERFORM 1 FROM public.job_quote_values('00000000-0000-0000-0000-000000000000'::uuid);
END $$;
