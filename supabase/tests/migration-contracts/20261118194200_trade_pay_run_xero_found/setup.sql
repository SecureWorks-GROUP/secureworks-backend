-- cl-payrun-xero-found prerequisites: the server-search release
-- (20261118193900), whose case stands up the run tables and the push claim.
SELECT to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)') IS NULL
    OR (SELECT md5(prosrc) FROM pg_proc
        WHERE oid = to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'))
       IS DISTINCT FROM '62293ef4dd638c21ab9a25c86669d9f4' AS need_release \gset
\if :need_release
\ir ../20261118193900_trade_pay_run_release_server_xero/setup.sql
\ir ../../../migrations/20261118193900_trade_pay_run_release_server_xero.sql
\endif
