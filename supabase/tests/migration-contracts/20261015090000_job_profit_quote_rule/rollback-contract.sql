-- After the down migration: v_job_profit is the 20261009130000 body again,
-- with the same columns, still service role only.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.v_job_profit') IS NULL THEN RAISE EXCEPTION 'jq rollback: v_job_profit is gone'; END IF;
  IF pg_get_viewdef('public.v_job_profit'::regclass) LIKE '%quote_sent_log_unverified%' THEN
    RAISE EXCEPTION 'jq rollback: the quote rule body survived the down migration';
  END IF;
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT') THEN RAISE EXCEPTION 'jq rollback: anon can read v_job_profit'; END IF;
  IF NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN RAISE EXCEPTION 'jq rollback: service_role cannot read v_job_profit'; END IF;
  PERFORM job_id, quoted_ex, expected_cost_ex, holding_job FROM public.job_profit('00000000-0000-0000-0000-000000000000'::uuid);
END $$;
