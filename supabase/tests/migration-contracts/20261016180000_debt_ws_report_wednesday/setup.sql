-- Pre-migration surface for the Wednesday debt report. debt_ws_settings comes from
-- 20261008170000_debt_workshop and trigger_debt_ws_report_auto() from
-- 20261015170000_debt_ws_report, both registered earlier in this stack, and
-- public.sw_service_key() from an earlier setup. Earlier cases assert that no cron or net
-- schema exists, so the pg_cron and pg_net stand-ins live inside contract.sql's
-- rolled-back transactions, never here.
SELECT 1;
