-- After the down migration: 20261118170500's release body is back, byte for byte.
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'))
     IS DISTINCT FROM '152edcbbc1ddff5f29d91e8f8af71860' THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore 20261118170500''s body';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST rollback changed who may call the release';
  END IF;
END $$;
\echo 'PASS: cl-payrun-xero-lookup rollback stands 20261118170500''s release body back up.'
