-- The runner has just run the down migration against the forward stack.
-- 1. The cap, the record trigger, the writer and the reads are gone; the
-- tables and their rows are kept.
DO $$
BEGIN
  IF to_regprocedure('public.assert_job_commission_cap(uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public.set_commission_rate(text, numeric, text, uuid)') IS NOT NULL
     OR to_regprocedure('public.record_job_commission_from_budget(public.job_budgets)') IS NOT NULL
     OR to_regprocedure('public.commission_write_once()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a commission function is still there';
  END IF;
  IF to_regclass('public.v_job_commission') IS NOT NULL OR to_regclass('public.v_commission_rates') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a commission read is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
             ('trade_invoice_lines_commission_cap', 'trade_invoices_commission_cap', 'job_budgets_record_commission')) THEN
    RAISE EXCEPTION 'rollback contract: a commission trigger is still there';
  END IF;
  IF to_regclass('public.job_commissions') IS NULL OR to_regclass('public.commission_rates') IS NULL
     OR to_regclass('public.commission_rate_settings') IS NULL
     OR (SELECT count(*) FROM public.commission_rates) <> 2 THEN
    RAISE EXCEPTION 'rollback contract: a commission table or the rate history was dropped';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261113230000_job_commissions_down.sql

-- 3. The forward migration applies again cleanly after a rollback, without
-- seeding the rates twice.
BEGIN;
\ir ../../../migrations/20261113230000_job_commissions.sql
DO $$
BEGIN
  IF to_regprocedure('public.assert_job_commission_cap(uuid, uuid)') IS NULL
     OR to_regclass('public.v_job_commission') IS NULL
     OR to_regclass('public.v_commission_rates') IS NULL
     OR (SELECT count(*) FROM public.commission_rates) <> 2 THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply cleanly';
  END IF;
END $$;
ROLLBACK;
