-- Later bodies of trade_pay_run_check_v2 built on 20261118194500's, rolled back
-- newest first so this case (and every earlier one, through
-- 20261118163000_trade_pay_run_holds_status/roll_back_check_successors.sql) meets
-- the body it asserts on. A newer successor adds its own down to the top.
SELECT coalesce((SELECT md5(prosrc) = 'fa27e07999e8d14a6cf0145f828818e9' FROM pg_proc
  WHERE oid = to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)')), false) AS zz_check_allow_list_live \gset
\if :zz_check_allow_list_live
\ir ../../../rollbacks/20261118999913_trade_pay_run_receipt_allow_list_down.sql
\endif
