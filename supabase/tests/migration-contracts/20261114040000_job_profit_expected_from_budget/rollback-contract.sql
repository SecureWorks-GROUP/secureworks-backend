-- The runner has just run the down migration against the forward stack.
-- 1. v_job_profit is 20261111100000's definition again, its three columns gone, job_profit(uuid) still there,
-- and the switch row gone.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> 'ef8c3682ff4da148ffe42635eb404abe' THEN
    RAISE EXCEPTION 'rollback contract: v_job_profit is not the earlier definition';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.v_job_profit'::regclass AND NOT attisdropped
              AND attname IN ('expected_other_ex', 'expected_budget_id', 'budget_gross_profit_ex')) THEN
    RAISE EXCEPTION 'rollback contract: a column this migration added is still there';
  END IF;
  IF to_regprocedure('public.job_profit(uuid)') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: job_profit(uuid) was not put back';
  END IF;
  IF has_table_privilege('authenticated', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'rollback contract: v_job_profit gained a browser grant';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_expected_from_job_budget') THEN
    RAISE EXCEPTION 'rollback contract: the switch row is still there';
  END IF;
  IF to_regclass('public.job_budgets') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: a table this migration does not own was dropped';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261114040000_job_profit_expected_from_budget_down.sql

-- 3. The forward migration applies again cleanly after a rollback, seeded off.
BEGIN;
\ir ../../../migrations/20261114040000_job_profit_expected_from_budget.sql
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '578270db501761330fad0b46412aac95'
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_profit_expected_from_job_budget') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
