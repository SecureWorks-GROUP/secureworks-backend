BEGIN;
SET LOCAL statement_timeout = '30s';
-- The rollback gives back main's body: the update no longer checks pay_run_id.
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure)
       <> 'd689b65f2fa743a8af8e5e795f2cc39e'
     OR (SELECT prosrc FROM pg_proc WHERE oid='public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure) LIKE '%pay_run_id%'
     OR has_function_privilege('anon','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.reject_trade_invoice_v1(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'reject_pay_run_rollback_body_or_roles';
  END IF;
END $$;
-- A second rollback changes nothing.
\ir ../../../rollbacks/20261119090200_trade_invoice_reject_pay_run_down.sql
-- The forward migration applies again on the rolled-back body.
\ir ../../../migrations/20261119090200_trade_invoice_reject_pay_run.sql
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure)
       <> '11db2726fa12909a671fdfc400082e4e' THEN
    RAISE EXCEPTION 'reject_pay_run_reapply_after_rollback';
  END IF;
END $$;
SELECT 'PASS: rollback restores main body and roles, is a no-op twice, and forward applies again' AS result;
ROLLBACK;
