-- The 20261005190000 (B-2) body of automation_switch_cron_lanes(), verbatim, so
-- this contract can re-apply its migration after a later slice (B-5,
-- 20261005210000) has replaced the lane list. md5(prosrc)
-- 8c99245789cadf661d4b6be1207f0887. Not a migration.
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    ('ghl-call-transcript-fetch', 'capture'),
    ('outlook-mail-poll', 'capture'),
    ('monitor-inbox-sweep', 'capture'),
    ('ghl-history-schedule', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
