-- Drop the jobname filter from the job reader. contract.sql must then fail:
-- another job's row is reported as the drain.
CREATE OR REPLACE FUNCTION public.ses_report_drain_cron_job()
RETURNS TABLE (jobid bigint, jobname text, schedule text, active boolean, username text, command_preview text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT j.jobid::bigint, j.jobname::text, j.schedule::text, j.active::boolean,
            j.username::text, left(j.command::text, 120)
       FROM cron.job j
      ORDER BY j.jobid';
END;
$$;
