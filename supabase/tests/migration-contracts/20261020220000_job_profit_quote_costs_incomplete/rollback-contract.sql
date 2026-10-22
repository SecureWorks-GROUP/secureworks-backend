-- After the down migration: v_job_profit is back to CFO-12's shape (no
-- quote_costs_incomplete column), JP-12 (20261020181800) is still in the view,
-- and job_profit(uuid) answers again.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.v_job_profit') IS NULL THEN
    RAISE EXCEPTION 'quote costs rollback: v_job_profit is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'v_job_profit' AND column_name = 'quote_costs_incomplete') THEN
    RAISE EXCEPTION 'quote costs rollback: quote_costs_incomplete survived the down migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'v_job_profit' AND column_name = 'invoice_emailed_ex') THEN
    RAISE EXCEPTION 'quote costs rollback: the CFO-12 columns were not restored';
  END IF;
  IF position('installer_bill_unconfirmed' in pg_get_viewdef('public.v_job_profit'::regclass)) = 0 THEN
    RAISE EXCEPTION 'quote costs rollback: JP-12 installer_bill_unconfirmed lost from v_job_profit';
  END IF;
  IF to_regprocedure('public.job_profit(uuid)') IS NULL THEN
    RAISE EXCEPTION 'quote costs rollback: job_profit(uuid) is missing';
  END IF;
  PERFORM 1 FROM public.job_profit('00000000-0000-0000-0000-000000000000'::uuid);
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'quote costs rollback: v_job_profit grants not restored';
  END IF;
END $$;
