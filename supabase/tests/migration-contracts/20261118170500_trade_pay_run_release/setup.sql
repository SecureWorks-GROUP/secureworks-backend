-- cl-payrun-escape prerequisites: the run tables (P1-10.1) and the push claim
-- (20261118163000), whose case stands them up.
SELECT to_regprocedure('public.claim_trade_pay_run_push(uuid,uuid,uuid)') IS NULL AS need_claim \gset
\if :need_claim
\ir ../20261118163000_trade_pay_run_holds_status/setup.sql
\ir ../../../migrations/20261118163000_trade_pay_run_holds_status.sql
\endif
