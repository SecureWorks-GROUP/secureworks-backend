-- Rollback for 20261113230000_job_commissions.sql. Takes away the cap, the
-- record trigger, the rate writer and both reads; keeps every table and row
-- (a rate history and a commission record are kept, never thrown away). With
-- the cap gone a commission line follows the rules from before step 2.
-- Safe to re-run.
DROP VIEW IF EXISTS public.v_job_commission;
DROP VIEW IF EXISTS public.v_commission_rates;
DO $$
BEGIN
  IF to_regclass('public.trade_invoice_lines') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trade_invoice_lines_commission_cap ON public.trade_invoice_lines;
  END IF;
  IF to_regclass('public.trade_invoices') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trade_invoices_commission_cap ON public.trade_invoices;
  END IF;
  IF to_regclass('public.job_budgets') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS job_budgets_record_commission ON public.job_budgets;
  END IF;
  IF to_regclass('public.job_commissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS job_commissions_write_once ON public.job_commissions;
    DROP TRIGGER IF EXISTS job_commissions_write_once_truncate ON public.job_commissions;
  END IF;
  IF to_regclass('public.commission_rates') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS commission_rates_write_once ON public.commission_rates;
    DROP TRIGGER IF EXISTS commission_rates_write_once_truncate ON public.commission_rates;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.trade_invoices_commission_cap();
DROP FUNCTION IF EXISTS public.trade_invoice_lines_commission_cap();
DROP FUNCTION IF EXISTS public.assert_job_commission_cap(uuid, uuid);
DROP FUNCTION IF EXISTS public.job_commission_claimed_ex_gst(uuid, uuid);
DROP FUNCTION IF EXISTS public.job_budgets_record_commission();
DROP FUNCTION IF EXISTS public.record_job_commission_from_budget(public.job_budgets);
DROP FUNCTION IF EXISTS public.set_commission_rate(text, numeric, text, uuid);
DROP FUNCTION IF EXISTS public.commission_write_once();
