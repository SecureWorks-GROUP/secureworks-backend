-- Prerequisites for 20261104110000_job_profit_patio_bound_revision (finish-line row A6, patio jobs).
-- The registered stack already holds everything it reads: v_job_profit as production printed it after 20261104080000
-- (md5 87cf36d110e184372e1707a4ff9e942e, put in place by that case's setup and migration), its
-- job_profit_expected_cost_missing(uuid) (md5 0c37d911341d324b45d164c9955e64a5), scope_revisions, xero_invoices and
-- v_job_cost_events. The view's text carries a timestamp, so the suite runs in UTC (PGTZ=UTC locally), as production's
-- hashes were taken.
DO $$
BEGIN
  IF to_regclass('public.v_job_profit') IS NULL OR to_regclass('public.scope_revisions') IS NULL
     OR to_regclass('public.xero_invoices') IS NULL OR to_regclass('public.v_job_cost_events') IS NULL
     OR to_regprocedure('public.job_profit_expected_cost_missing(uuid)') IS NULL
     OR to_regprocedure('public.job_profit_safe_jsonb(text)') IS NULL
     OR to_regprocedure('public.job_profit_num(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'patio bound revision prerequisites missing: v_job_profit with expected_cost_missing, scope revisions, xero invoices, job cost events';
  END IF;
END $$;
