-- The CRM list this slice replaces is not the body it was built on, and the
-- lane list is neither the 20261005210000 body nor the deep email history
-- PR's (20261007080000) nor one naming xero-history-daily: the migration must
-- refuse rather than overwrite live changes nobody read, and name both.
CREATE OR REPLACE FUNCTION public.context_ghl_history_live_jobs()
RETURNS TABLE(job_id uuid, job_number text, ghl_contact_id text, status text, live_basis text, tier integer, activity_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::timestamptz WHERE false
$$;
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES ('monitor-inbox-poll', 'capture'), ('someone-elses-new-job', 'capture'), ('contact-matching', 'attribution')) AS t(cron_jobname, lane);
$fn$;
