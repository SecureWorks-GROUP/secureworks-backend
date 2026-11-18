-- After the down migration: 20261118163000's check body is back, byte for byte.
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)'))
     IS DISTINCT FROM '7bf3b7dbccc9c5ef8656b6c43e3e9a0b' THEN
    RAISE EXCEPTION 'ZZTEST rollback did not give back 20261118163000''s check body';
  END IF;
  IF has_function_privilege('anon', 'public.trade_pay_run_check_v2(date,integer,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trade_pay_run_check_v2(date,integer,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.trade_pay_run_check_v2(date,integer,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST rollback changed the check''s privileges';
  END IF;
END $$;
\echo 'PASS: cl-payrun-v1-followups rollback gives back the earlier check body and its privileges.'
