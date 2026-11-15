-- Prerequisites for 20261115130000_job_cost_close. Earlier registered cases supply everything the migration
-- reads: Job Profit's view, the jobs table and client sign-offs. This case adds nothing. Fail closed, by name,
-- if any of it is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.v_job_profit', 'public.jobs', 'public.job_client_signoffs',
                           'public.job_materials_facts', 'public.xero_invoices', 'public.purchase_orders'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'job cost close setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.job_profit_partial_cost_policy()') IS NULL THEN
    RAISE EXCEPTION 'job cost close setup: job_profit_partial_cost_policy() missing from the registered stack';
  END IF;
END $$;
