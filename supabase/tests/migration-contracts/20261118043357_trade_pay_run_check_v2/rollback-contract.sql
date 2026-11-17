\echo == P1-08.1 rollback preserves v1 ==
DO $$ BEGIN
 IF to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)') IS NOT NULL THEN
   RAISE EXCEPTION 'ZZTEST rollback left v2';
 END IF;
 IF public.trade_pay_run_check('2026-11-25',1,md5('ZZTEST absent org')::uuid)->>'rule' <> 'trade-pay-check-v1' THEN
   RAISE EXCEPTION 'ZZTEST rollback changed v1';
 END IF;
END $$;
\echo PASS P1-08.1 rollback preserves v1
