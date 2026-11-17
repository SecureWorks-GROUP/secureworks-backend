BEGIN;
DO $$ BEGIN
 IF strpos(pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure), '-- FU17: only switched-on') > 0
 OR strpos(pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure), '-- FU12: release only') = 0
 THEN RAISE EXCEPTION 'FU17 rollback did not restore dated receipt replacement'; END IF;
END $$;
ROLLBACK;
\ir ../20261117194401_trade_reimbursement_receipt_replacement/contract.sql
