-- Prerequisites for 20261029170000_cfo_bill_cost_outcomes. Earlier registered
-- cases build the engine (v_job_cost_events, v_job_profit), the allocation
-- rows, the queue and the credit and installer helpers. This adds nothing.
-- Fail closed if one is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.v_job_cost_events', 'public.v_job_profit', 'public.job_materials_facts',
                           'public.materials_reconciliation_queue', 'public.xero_invoices',
                           'public.trade_invoices', 'public.jobs'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'cfo bill cost outcomes setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.job_cost_credit_share(jsonb, numeric)') IS NULL
     OR to_regprocedure('public.job_cost_installer_bill(jsonb)') IS NULL
     OR to_regprocedure('public.job_profit_num(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'cfo bill cost outcomes setup: an engine helper is missing';
  END IF;
END $$;
