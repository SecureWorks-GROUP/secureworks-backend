-- Rollback of 20261118074812_trade_pay_runs.
--
-- One statement, so it refuses whole or runs whole. Refuses while any pay run
-- is recorded (those rows are the record of who approved which invoices), and
-- refuses when pay_run_id, reviewed_at or reviewed_by is on trade_invoices
-- without this migration's "P1-10.1:" comment (someone else's column, never
-- dropped here), and when approve_trade_pay_run is not this migration's own
-- body (Rule 15). Otherwise drops, in reverse order, the approve function, the
-- three invoice columns and the run index, the two tables and the switch.
-- Leaves the pay_run_stopped office kind (phase 2 owns that list).
--
-- The limits are set before the statement so they bound it. The tables are
-- locked before the emptiness check and held to the end, in the order an
-- approval takes them (trade_invoices, then the run tables): an approval that
-- is running when the rollback starts finishes first and is then seen; one
-- that starts later waits behind the rollback and never writes a run the
-- rollback has already checked for.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $down$
DECLARE
  v_unowned text;
/* block */ BEGIN
  LOCK TABLE public.trade_invoices IN ACCESS EXCLUSIVE MODE;
  IF to_regclass('public.trade_pay_run_invoices') IS NOT NULL THEN
    LOCK TABLE public.trade_pay_run_invoices IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.trade_pay_runs') IS NOT NULL THEN
    LOCK TABLE public.trade_pay_runs IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.trade_pay_runs) THEN
      RAISE EXCEPTION 'trade_pay_runs rollback: pay runs are recorded; they cannot be dropped';
    END IF;
  END IF;
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_unowned
  FROM pg_attribute a
  WHERE a.attrelid = 'public.trade_invoices'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname IN ('pay_run_id', 'reviewed_at', 'reviewed_by')
    AND coalesce(col_description(a.attrelid, a.attnum), '') NOT LIKE 'P1-10.1:%';
  IF v_unowned IS NOT NULL THEN
    RAISE EXCEPTION 'trade_pay_runs rollback: trade_invoices.% not created by this migration; refusing to drop', v_unowned;
  END IF;

  -- Rule 15: only this migration's own body is dropped.
  IF (SELECT md5(p.prosrc) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.approve_trade_pay_run(uuid,date,uuid,jsonb)'))
     IS DISTINCT FROM '422a37ee4add48ff6bd7ca221d9fda7f'
     AND to_regprocedure('public.approve_trade_pay_run(uuid,date,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'trade_pay_runs rollback: approve_trade_pay_run is another body; refusing to drop it';
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
