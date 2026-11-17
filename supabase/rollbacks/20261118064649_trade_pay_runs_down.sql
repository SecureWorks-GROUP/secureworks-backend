-- Rollback of 20261118064649_trade_pay_runs.
--
-- Refuses while any pay run is recorded: those rows are the record of who
-- approved which invoices. Otherwise drops, in reverse order, the approve
-- function, the three invoice columns (reviewed_by, reviewed_at, pay_run_id)
-- and the run index, the two tables and the switch.
-- Leaves the pay_run_stopped office kind (phase 2 owns that list).

DO $$
/* block */ BEGIN
  IF to_regclass('public.trade_pay_runs') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.trade_pay_runs) THEN
    RAISE EXCEPTION 'trade_pay_runs rollback: pay runs are recorded; they cannot be dropped';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.approve_trade_pay_run(uuid, date, uuid, jsonb);
DROP INDEX IF EXISTS public.trade_invoices_pay_run_idx;
ALTER TABLE public.trade_invoices DROP COLUMN IF EXISTS reviewed_by;
ALTER TABLE public.trade_invoices DROP COLUMN IF EXISTS reviewed_at;
ALTER TABLE public.trade_invoices DROP COLUMN IF EXISTS pay_run_id;
DROP TABLE IF EXISTS public.trade_pay_run_invoices;
DROP TABLE IF EXISTS public.trade_pay_runs;
DELETE FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1';
