-- cl-payrun-xero-lookup prerequisites: the release function (20261118170500),
-- whose case stands up the run tables and the push claim.
SELECT to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)') IS NULL AS need_release \gset
\if :need_release
\ir ../20261118170500_trade_pay_run_release/setup.sql
\ir ../../../migrations/20261118170500_trade_pay_run_release.sql
\endif
