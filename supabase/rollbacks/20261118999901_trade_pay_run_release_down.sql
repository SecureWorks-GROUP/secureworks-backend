-- Rollback of cl-payrun-escape (20261118999901). Run it before
-- 20261118163000's rollback (that one drops the push claim columns this
-- function clears).
--
-- Refuses when another body is installed at the signature, and when any run
-- row carries a release record: the record is the only trace of who took the
-- invoice out of its run and why, and the row reads stopped because of it.
-- Drops the function, then the three columns (only when they are this
-- migration's). Locks trade_pay_run_invoices (ACCESS EXCLUSIVE, DROP COLUMN).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
/* block */ BEGIN
  IF to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,boolean)') IS NOT NULL
     AND (SELECT md5(p.prosrc) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,boolean)'))
         IS DISTINCT FROM '4fd4374d1e8b365dc16bf206ceec1e78' THEN
    RAISE EXCEPTION 'release_trade_pay_run_invoice rollback: another body is installed; refusing to drop it';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass
               AND a.attname = 'released_at' AND NOT a.attisdropped)
     AND EXISTS (SELECT 1 FROM public.trade_pay_run_invoices WHERE released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'release_trade_pay_run_invoice rollback: a release is recorded; refusing to drop the record';
  END IF;
END;
$guard$;

DROP FUNCTION IF EXISTS public.release_trade_pay_run_invoice(uuid, uuid, uuid, text, boolean);

DO $cols$
DECLARE
  c text;
/* block */ BEGIN
  FOREACH c IN ARRAY ARRAY['released_at', 'released_by', 'release_reason'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass AND a.attname = c
                 AND NOT a.attisdropped
                 AND coalesce(col_description(a.attrelid, a.attnum), '') LIKE 'cl-payrun-escape:%') THEN
      EXECUTE format('ALTER TABLE public.trade_pay_run_invoices DROP COLUMN %I', c);
    END IF;
  END LOOP;
END;
$cols$;
