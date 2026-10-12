-- Rollback of 20261012180000_trade_invoice_time_entries.
--
-- Takes back the surface, never the record: the per-job view, the stamping
-- persist wrapper and the enforcement flag go. The four columns on
-- trade_invoice_lines (work_date, start_time, finish_time, break_minutes),
-- their check and their index STAY, because the times trades entered are kept
-- nowhere else and a rollback must not destroy them. Table
-- job_assignment_logged_times (times saved on the job view) stays for the
-- same reason; nothing reads it once the matching ops-api is rolled back.
--
-- Roll the matching ops-api back first: it calls
-- persist_weekly_trade_invoice_v2. persist_weekly_trade_invoice_v1 is
-- untouched by the forward migration and stays as it is.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP VIEW IF EXISTS public.job_trade_time_entries;

DROP FUNCTION IF EXISTS public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid);

DELETE FROM public.feature_flags
WHERE flag_name = 'trade_invoice_time_entry_required_v1';
