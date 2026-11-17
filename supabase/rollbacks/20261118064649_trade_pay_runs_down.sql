-- Rollback of 20261118064649_trade_pay_runs.
--
-- One statement, so it refuses whole or runs whole. Refuses while any pay run
-- is recorded (those rows are the record of who approved which invoices), and
-- refuses when pay_run_id, reviewed_at or reviewed_by is on trade_invoices
-- without this migration's "P1-10.1:" comment (someone else's column, never
-- dropped here). Otherwise drops, in reverse order, the approve function, the
-- three invoice columns and the run index, the two tables and the switch.
-- Leaves the pay_run_stopped office kind (phase 2 owns that list).

DO $down$
DECLARE
  v_unowned text;
/* block */ BEGIN
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '60s';
  IF to_regclass('public.trade_pay_runs') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.trade_pay_runs) THEN
    RAISE EXCEPTION 'trade_pay_runs rollback: pay runs are recorded; they cannot be dropped';
  END IF;
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_unowned
  FROM pg_attribute a
  WHERE a.attrelid = 'public.trade_invoices'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname IN ('pay_run_id', 'reviewed_at', 'reviewed_by')
    AND coalesce(col_description(a.attrelid, a.attnum), '') NOT LIKE 'P1-10.1:%';
  IF v_unowned IS NOT NULL THEN
    RAISE EXCEPTION 'trade_pay_runs rollback: trade_invoices.% not created by this migration; refusing to drop', v_unowned;
  END IF;

  DROP FUNCTION IF EXISTS public.approve_trade_pay_run(uuid, date, uuid, jsonb);
  DROP INDEX IF EXISTS public.trade_invoices_pay_run_idx;
  ALTER TABLE public.trade_invoices DROP COLUMN IF EXISTS reviewed_by;
  ALTER TABLE public.trade_invoices DROP COLUMN IF EXISTS reviewed_at;
  ALTER TABLE public.trade_invoices DROP COLUMN IF EXISTS pay_run_id;
  DROP TABLE IF EXISTS public.trade_pay_run_invoices;
  DROP TABLE IF EXISTS public.trade_pay_runs;
  DELETE FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1';
END;
$down$;
