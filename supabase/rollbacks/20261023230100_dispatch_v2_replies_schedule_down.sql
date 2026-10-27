-- Down for 20261023230100_dispatch_v2_replies_schedule. Stops the supplier
-- reply scan. What it already matched stays in the dispatch_v2_* reply tables
-- (dropped only by 20261023230000_dispatch_v2_replies_tables_down.sql).
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'dispatch-v2-replies-scan';
  END IF;
END $cron$;

DROP FUNCTION IF EXISTS public.trigger_dispatch_v2_replies_scan();

DELETE FROM public.feature_flags WHERE flag_name = 'dispatch_v2_replies_v1';
