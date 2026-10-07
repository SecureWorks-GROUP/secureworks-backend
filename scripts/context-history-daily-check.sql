-- History daily (migration 20261007050000): the after-merge check. READ ONLY:
-- every statement runs inside BEGIN READ ONLY and the file ends in ROLLBACK.
-- Ids and counts only. Run it once after the merge, again after the first
-- scheduled CRM cycles (the load takes the added jobs at 25 a cycle, one
-- cycle every 15 minutes) and after the first 03:30 Perth Xero top-up.
--
-- What correct looks like (measured on production 7 Oct 2026 about 13:15
-- Perth, before the merge):
--  1. CRM read: 496 monitored live jobs of 862; 161 loaded, 291 tried with no
--     contact, 44 missing (39 history_not_started on 37 contacts, 5
--     link_not_tried). After the load: missing near 0 (a failed contact is
--     retried on a later day; a never-tried job is tried in the first cycle).
--  2. The CRM list: 532 jobs (M4's 485 plus 47 monitored live jobs).
--  3. Xero: the cron job xero-history-daily active, 30 19 * * *, command
--     matching; before the first run 14 rows missing (6 raised, 8
--     authorised) on 11 jobs; after it, missing_rows 0 and one
--     xero_history_daily run, status succeeded.
--  4. The lane list names xero-history-daily on the capture lane.
BEGIN READ ONLY;

-- 1. Where every monitored live job's CRM history stands, and which lead rule decided.
SELECT public.context_history_crm_summary() AS crm;

-- 2. The CRM load's list and the load's own after-check (B-2).
SELECT count(*) AS crm_list_jobs, count(*) FILTER (WHERE live_basis = 'lead_monitored') AS lead_monitored,
 count(*) FILTER (WHERE live_basis = 'quote_sent') AS quote_sent, count(*) FILTER (WHERE live_basis = 'status') AS by_status
FROM public.context_ghl_history_live_jobs();
SELECT public.context_ghl_history_progress() AS ghl_progress;

-- 3. The daily Xero top-up: cron job, newest run, what is still missing.
SELECT public.context_history_xero_daily_status() AS xero_daily;

-- 4. The capture lane owns the job.
SELECT cron_jobname, lane FROM public.automation_switch_cron_lanes() WHERE cron_jobname = 'xero-history-daily';

-- 5. The missing CRM jobs by reason (ids only), for a person to look at any
-- that stay missing after the first cycles.
SELECT c.reason, count(*) AS jobs, array_agg(c.job_id ORDER BY c.job_id) AS job_ids
FROM public.context_history_crm_jobs() c WHERE c.crm_state = 'missing'
GROUP BY c.reason ORDER BY c.reason COLLATE "C";

ROLLBACK;
