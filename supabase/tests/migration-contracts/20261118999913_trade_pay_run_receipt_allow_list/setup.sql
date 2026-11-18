-- SEC-465 allow-list prerequisites: the check body this migration replaces
-- (20261118194500, whose case stands up 20261118163000's body and the receipt mark).
SELECT to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)') IS NULL
    OR (SELECT md5(prosrc) FROM pg_proc
        WHERE oid = to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)'))
       NOT IN ('c6c1f4da1fb43e2fb781b884502a7b5d', 'daee6c551634e062577f1c7f45950ae8') AS need_check \gset
\if :need_check
\ir ../20261118194500_trade_pay_run_receipt_not_booked/setup.sql
\ir ../../../migrations/20261118194500_trade_pay_run_receipt_not_booked.sql
\endif
