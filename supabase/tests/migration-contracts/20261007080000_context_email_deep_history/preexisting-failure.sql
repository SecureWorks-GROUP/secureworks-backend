-- A live change nobody read: the lane list replaced by another slice's body.
-- The guard must refuse and name it.
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $fn$ SELECT * FROM (VALUES ('outlook-mail-poll','capture'),('xero-history-daily','capture')) AS t(cron_jobname, lane); $fn$;
