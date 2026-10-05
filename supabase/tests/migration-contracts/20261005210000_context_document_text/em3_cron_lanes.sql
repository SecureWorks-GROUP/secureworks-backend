-- The email reader's automation_switch_cron_lanes(), byte for byte
-- (20261002150000, md5(prosrc) 5c1e0e526a74d5b4ad612792c7f076cc). Not a
-- migration. The email reader's contract re-applies its migration inside a
-- rolled-back transaction; B-5 (20261005210000) adds its own job to this
-- list, so that contract loads this file first to stand the email reader's
-- pre-image back up. B-5's contract checks the md5.
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
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
