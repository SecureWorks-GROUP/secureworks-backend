-- After the down migration: main's approve_trade_pay_run is back, byte for
-- byte (md5 of P1-10.1's body), and the run tables are untouched.
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)'::regprocedure)
     IS DISTINCT FROM '422a37ee4add48ff6bd7ca221d9fda7f' THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore main''s approve body';
  END IF;
  IF to_regclass('public.trade_pay_runs') IS NULL OR to_regclass('public.trade_pay_run_invoices') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback removed the run tables';
  END IF;
  IF to_regprocedure('public.claim_trade_pay_run_push(uuid,uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.release_trade_pay_run_push(uuid,uuid,timestamptz)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass
                AND a.attname IN ('push_claimed_at', 'push_claimed_by') AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'ZZTEST rollback left the push claim behind';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure)
     IS DISTINCT FROM 'c36b18bc0c4c4bc4b1ffed9021717664' THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore P1-08.1''s check body';
  END IF;
END $$;
\echo 'PASS: cl-1622-fix rollback restores main''s approve body and drops the push claim, and P1-08.1''s check body is back.'
