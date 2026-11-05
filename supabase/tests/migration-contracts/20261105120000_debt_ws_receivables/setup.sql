-- Pre-migration surface for the receivables change: debt_ws_settings (with its id = 1 row)
-- comes from 20261008170000_debt_workshop, trigger_debt_ws_report_auto() from
-- 20261015170000_debt_ws_report and trigger_debt_ws_report_refresh() from
-- 20261016180000_debt_ws_report_wednesday, all registered earlier in this stack. Earlier
-- cases assert that no cron schema exists, so the pg_cron stand-in lives inside
-- contract.sql's rolled-back transactions, never here.
SELECT 1;
