-- C1d's automation_switch_cron_lanes(), byte for byte (20260924133000,
-- md5(prosrc) 459035de5d3f7f7af49c36f09d9be29e). Not a migration. C1d's
-- contract re-applies C1d inside a rolled-back transaction; T2
-- (20260925043000) adds its own job to this list, so that contract loads this
-- file first to stand C1d's pre-image back up. This contract checks the md5.
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
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
