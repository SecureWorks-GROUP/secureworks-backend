-- The lane list of the history daily slice (20261007050000, PR 989 at
-- 446ab25e) verbatim: B-5's body plus ('xero-history-daily','capture').
-- md5(prosrc) 81cbebf914f537b0b85870196cbd0f75. This case stands it up inside
-- a rolled-back transaction to prove that this migration, applied after that
-- slice, adds its own row and keeps every row there, and that its rollback
-- gives that slice's body back byte for byte.
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
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;
