-- The 20261005210000 (B-5) body of automation_switch_cron_lanes(), verbatim,
-- md5(prosrc) 99e6d70e80a79e548f2478b65fc6cd78, so a contract can re-apply a
-- migration that pins it after 20261007050000 added the xero-history-daily row
-- (inside a rolled-back transaction). Not a migration.
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
    ('context-document-text', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
