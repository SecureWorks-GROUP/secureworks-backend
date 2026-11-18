-- Rollback of cl-payrun-xero-found (20261118999911): drops the recording
-- function and the run row's release_xero_found column. Refuses while any run
-- row holds a found bill, so a record is never thrown away by a rollback.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
/* block */ BEGIN
  IF to_regprocedure('public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)') IS NOT NULL
     AND (SELECT md5(p.prosrc) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)'))
         IS DISTINCT FROM '2c21adbf78f1aeeb2dd329e5c1beea71' THEN
    RAISE EXCEPTION 'record_trade_pay_run_xero_found rollback: another body is installed; refusing to drop it';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = to_regclass('public.trade_pay_run_invoices')
               AND a.attname = 'release_xero_found' AND NOT a.attisdropped) THEN
    IF EXISTS (SELECT 1 FROM public.trade_pay_run_invoices WHERE release_xero_found IS NOT NULL) THEN
      RAISE EXCEPTION 'record_trade_pay_run_xero_found rollback: a run row holds a found Xero bill; refusing to drop it';
    END IF;
  END IF;
END;
$guard$;

DROP FUNCTION IF EXISTS public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb);
ALTER TABLE public.trade_pay_run_invoices DROP COLUMN IF EXISTS release_xero_found;
