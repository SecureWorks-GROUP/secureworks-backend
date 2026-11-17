BEGIN;
SET LOCAL statement_timeout = '120s';
\ir ../../../migrations/20261118042110_trade_savings_goals.sql
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('f1070001-0000-4000-8000-000000000001', 'f1070001-0000-4000-8000-000000000002', 'ZZTEST trade', 'crew');
CREATE FUNCTION pg_temp.zztest_refuses(command text, expected text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE command;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'ZZTEST expected refusal %', expected;
END $$;
SELECT pg_temp.zztest_refuses($q$INSERT INTO public.trade_savings_goals (user_id,label,target_amount)
  VALUES ('f1070001-0000-4000-8000-000000000001','ZZTEST goal',0)$q$, '23514');
SELECT pg_temp.zztest_refuses($q$INSERT INTO public.trade_savings_goals (user_id,label,target_amount)
  VALUES ('f1070001-0000-4000-8000-000000000001',repeat('Z',61),1)$q$, '23514');
INSERT INTO public.trade_savings_goals (user_id,label,target_amount)
  VALUES ('f1070001-0000-4000-8000-000000000001','ZZTEST goal',1);
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM public.trade_savings_goals WHERE user_id='f1070001-0000-4000-8000-000000000001'
    AND label='ZZTEST goal' AND target_amount=1 AND saved_amount=0 AND updated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ZZTEST saved goal did not read back';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.trade_savings_goals'::regclass) THEN
    RAISE EXCEPTION 'ZZTEST row security is off';
  END IF;
  IF has_table_privilege('authenticated','public.trade_savings_goals','SELECT,INSERT,UPDATE,DELETE')
    OR NOT has_table_privilege('service_role','public.trade_savings_goals','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'ZZTEST role privileges differ';
  END IF;
END $$;
SELECT pg_temp.zztest_refuses($q$INSERT INTO public.trade_savings_goals (user_id,label,target_amount)
  VALUES ('f1070001-0000-4000-8000-000000000001','ZZTEST second goal',2)$q$, '23505');
SET LOCAL ROLE anon;
SELECT pg_temp.zztest_refuses('SELECT * FROM public.trade_savings_goals', '42501');
RESET ROLE;
ROLLBACK;
