-- cl-1622-fix prerequisites: everything P1-10.1's case needs, then P1-10.1
-- itself (the body this migration replaces). No stand-in replaces a main object.
\ir ../20261118115852_trade_pay_runs/setup.sql
SELECT to_regprocedure('public.approve_trade_pay_run(uuid,date,uuid,jsonb)') IS NULL AS need_runs \gset
\if :need_runs
\ir ../../../migrations/20261118115852_trade_pay_runs.sql
\endif
-- The check body the hourly note replaces (P1-08.1).
SELECT to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)') IS NULL AS need_check \gset
\if :need_check
\ir ../../../migrations/20261118043357_trade_pay_run_check_v2.sql
\endif
