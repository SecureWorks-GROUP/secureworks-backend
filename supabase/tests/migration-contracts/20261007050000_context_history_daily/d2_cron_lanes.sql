-- The list naming both jobs, verbatim, md5(prosrc)
-- 6498276b1eb16b527fb76dd2b0fa6d83: the 20261005210000 list plus
-- ('xero-history-daily', 'capture') and then ('outlook-mail-deep-history',
-- 'capture'). The deep email history PR (20261007080000, PR 987, its fix after
-- review) writes it on this migration's body, and this migration writes it on
-- that PR's, so either merge order ends on this one body. Lets this case prove
-- the order where this migration applies first (inside a rolled-back
-- transaction). Not a migration.
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
    ('xero-history-daily', 'capture'),
    ('outlook-mail-deep-history', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
