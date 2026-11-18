-- After the down migration: the recording function and the column are gone,
-- and the release is untouched.
DO $$
BEGIN
  IF to_regprocedure('public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback left the recording function';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass
             AND a.attname = 'release_xero_found' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'ZZTEST rollback left release_xero_found';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'))
     IS DISTINCT FROM '62293ef4dd638c21ab9a25c86669d9f4' THEN
    RAISE EXCEPTION 'ZZTEST rollback changed the release';
  END IF;
END $$;
\echo 'PASS: cl-payrun-xero-found rollback drops the recording function and its column; the release is untouched.'
