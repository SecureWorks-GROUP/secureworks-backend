-- The deep email history PR's body of automation_switch_cron_lanes()
-- (20261007080000, PR 987, branch ctx/email-deep-history, head b7eafaa6),
-- verbatim, md5(prosrc) 250d7e9ec2ebecc7e83192a39b7da488: the 20261005210000
-- list plus ('outlook-mail-deep-history', 'capture'). Lets this case prove the
-- order where that PR applies first (inside a rolled-back transaction). Not a
-- migration.
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
    ('outlook-mail-deep-history', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
