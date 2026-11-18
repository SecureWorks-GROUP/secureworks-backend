-- After the down migration: the function and its four columns are gone, and
-- the run tables and the push claim (20261118163000) are untouched.
DO $$
BEGIN
  IF to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback left the release function';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass
             AND a.attname IN ('released_at', 'released_by', 'release_reason', 'release_xero_check') AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'ZZTEST rollback left a release column';
  END IF;
  IF to_regprocedure('public.claim_trade_pay_run_push(uuid,uuid,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass
                    AND a.attname = 'push_claimed_at' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'ZZTEST rollback removed the push claim';
  END IF;
END $$;
\echo 'PASS: cl-payrun-escape rollback drops the release function and its columns and leaves the push claim.'
