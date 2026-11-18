-- Later bodies of trade_pay_run_check_v2 built on 20261118163000's, rolled back
-- newest first so an earlier contract meets the body it asserts on (contracts
-- run against the full stack). A newer successor adds its own down to the top.
SELECT coalesce((SELECT md5(prosrc) = 'c6c1f4da1fb43e2fb781b884502a7b5d' FROM pg_proc
  WHERE oid = to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)')), false) AS zz_check_receipt_live \gset
\if :zz_check_receipt_live
\ir ../../../rollbacks/20261118999912_trade_pay_run_receipt_not_booked_down.sql
\endif
