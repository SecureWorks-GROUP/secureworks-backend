-- cl-payrun-v1-followups prerequisites: the check body this migration replaces
-- (20261118163000, whose case stands up the run tables and check v2) and the
-- receipt mark (20261118194000).
SELECT to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)') IS NULL
    OR (SELECT md5(prosrc) FROM pg_proc
        WHERE oid = to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)'))
       NOT IN ('7bf3b7dbccc9c5ef8656b6c43e3e9a0b', 'c6c1f4da1fb43e2fb781b884502a7b5d') AS need_check \gset
\if :need_check
\ir ../20261118163000_trade_pay_run_holds_status/setup.sql
\ir ../../../migrations/20261118163000_trade_pay_run_holds_status.sql
\endif
SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
  AND table_name = 'expense_receipts' AND column_name = 'unbooked_job_id') AS need_mark \gset
\if :need_mark
\ir ../20261118194000_expense_unbooked_job_mark/setup.sql
\ir ../../../migrations/20261118194000_expense_unbooked_job_mark.sql
\endif
