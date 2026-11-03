-- After 20261104110000's down: v_job_profit and job_profit_expected_cost_missing(uuid) are their 20261104080000
-- definitions again (production's md5s), and the views and functions this migration added are gone.
DO $$
BEGIN
  SET LOCAL TimeZone = 'UTC';
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '87cf36d110e184372e1707a4ff9e942e' THEN
    RAISE EXCEPTION 'rollback: v_job_profit is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public.job_profit_expected_cost_missing(uuid)'))) <> '0c37d911341d324b45d164c9955e64a5' THEN
    RAISE EXCEPTION 'rollback: job_profit_expected_cost_missing(uuid) is not the earlier definition';
  END IF;
  IF to_regclass('public.v_job_profit_patio_scope_binding') IS NOT NULL OR to_regclass('public.v_job_profit_share_invoices') IS NOT NULL
     OR to_regprocedure('public.job_profit_patio_revision_pricing(text,text)') IS NOT NULL
     OR to_regprocedure('public.job_profit_share_on_price(numeric,numeric,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: an object this migration added is still there';
  END IF;
  PERFORM 1 FROM public.v_job_profit LIMIT 1;
  PERFORM 1 FROM public.job_profit('00000000-0000-0000-0000-000000000000');
END $$;
