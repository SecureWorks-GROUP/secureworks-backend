-- Show the SES report drain's pg_cron job, visible run count and recent pg_net
-- responses (CIO, 2026-09-11). Read-only observability; no scheduling change.
--
-- Live question 11 Sep: after 20260911090000_ses_report_drain_own_flag shipped,
-- ses_report_drain_cron_runs() returned 2026-09-11T00:07:00Z as the newest run
-- at 02:23Z. Either the job stopped (unscheduled or active = false), or it was
-- re-created under another database role. pg_cron puts row security on both
-- cron.job and cron.job_run_details (USING username = current_user), so a
-- SECURITY DEFINER reader only sees jobs and runs owned by its own role. Nobody
-- on the ops seat can query production, so these readers let ops-api say which
-- of those it is:
--   * ses_report_drain_cron_job(): the job row(s) named ses-report-trigger-drain
--     with schedule, active flag, owning username and a command preview. Empty
--     means no such job exists for this role (absent, or owned by another role).
--   * ses_report_drain_cron_run_count(): every job_run_details row for that
--     jobname the definer can see, across all its jobids and without a username
--     filter. NULL when pg_cron is absent or the definer lacks privilege.
--   * ses_report_cron_scheduler_pulse(p_limit): every visible cron.job row with
--     its newest run, newest first. If every job's newest run is old, the whole
--     pg_cron scheduler stopped rather than this one job.
--   * ses_report_drain_http_responses(p_limit): the latest net._http_response
--     rows. pg_net does not keep the request URL with a response, so these are
--     the latest responses overall from every net.http_post caller, not only
--     drain posts.
-- All four: fixed search_path, service_role and postgres only, dynamic SQL
-- behind a to_regclass guard so a database without pg_cron or pg_net (the
-- contract runner, a partial restore) returns an empty answer.

CREATE OR REPLACE FUNCTION public.ses_report_drain_cron_job()
RETURNS TABLE (
  jobid bigint,
  jobname text,
  schedule text,
  active boolean,
  username text,
  command_preview text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT j.jobid::bigint, j.jobname::text, j.schedule::text, j.active::boolean,
            j.username::text, left(j.command::text, 120)
       FROM cron.job j
      WHERE j.jobname = $1
      ORDER BY j.jobid'
    USING 'ses-report-trigger-drain';
END;
$$;

CREATE OR REPLACE FUNCTION public.ses_report_drain_cron_run_count()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count bigint;
BEGIN
  BEGIN
    IF to_regclass('cron.job') IS NULL OR to_regclass('cron.job_run_details') IS NULL THEN
      RETURN NULL;
    END IF;
    EXECUTE
      'SELECT count(*)
         FROM cron.job_run_details d
        WHERE d.jobid IN (SELECT j.jobid FROM cron.job j WHERE j.jobname = $1)'
      INTO v_count
      USING 'ses-report-trigger-drain';
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NULL;
  END;
  RETURN v_count;
END;
$$;

-- net._http_response carries no URL or request link once the queue row is
-- gone, so this returns the latest responses from every pg_net caller.
CREATE OR REPLACE FUNCTION public.ses_report_drain_http_responses(p_limit integer DEFAULT 5)
RETURNS TABLE (
  id bigint,
  status_code integer,
  content_preview text,
  created timestamptz,
  timed_out boolean,
  error_msg text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('net._http_response') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT r.id::bigint, r.status_code::integer, left(r.content::text, 200),
            r.created::timestamptz, r.timed_out::boolean, r.error_msg::text
       FROM net._http_response r
      ORDER BY r.created DESC NULLS LAST, r.id DESC
      LIMIT $1'
    USING greatest(1, least(coalesce(p_limit, 5), 20));
END;
$$;

-- Whole-scheduler pulse: every cron.job row the definer can see, with the
-- newest run it has. A LEFT JOIN so a job that has never run still appears, and
-- newest start_time first so a dead scheduler is obvious at a glance: if EVERY
-- job's newest run is old, pg_cron itself stopped, not just the drain. Same
-- to_regclass guard and dynamic SQL as the readers above, and a second branch
-- for a database that has cron.job but no cron.job_run_details.
CREATE OR REPLACE FUNCTION public.ses_report_cron_scheduler_pulse(p_limit integer DEFAULT 30)
RETURNS TABLE (
  jobid bigint,
  jobname text,
  schedule text,
  active boolean,
  username text,
  last_start_time timestamptz,
  last_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 50));
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('cron.job_run_details') IS NULL THEN
    RETURN QUERY EXECUTE
      'SELECT j.jobid::bigint, j.jobname::text, j.schedule::text, j.active::boolean,
              j.username::text, NULL::timestamptz, NULL::text
         FROM cron.job j
        ORDER BY j.jobid
        LIMIT $1'
      USING v_limit;
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT j.jobid::bigint, j.jobname::text, j.schedule::text, j.active::boolean,
            j.username::text, d.start_time::timestamptz, d.status::text
       FROM cron.job j
       LEFT JOIN LATERAL (
              SELECT r.start_time, r.status
                FROM cron.job_run_details r
               WHERE r.jobid = j.jobid
               ORDER BY r.start_time DESC NULLS LAST, r.runid DESC
               LIMIT 1
            ) d ON true
      ORDER BY d.start_time DESC NULLS LAST, j.jobid
      LIMIT $1'
    USING v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.ses_report_drain_cron_job() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ses_report_drain_cron_run_count() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ses_report_drain_http_responses(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ses_report_drain_cron_job() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.ses_report_drain_cron_run_count() TO service_role, postgres;
REVOKE ALL ON FUNCTION public.ses_report_cron_scheduler_pulse(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ses_report_drain_http_responses(integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.ses_report_cron_scheduler_pulse(integer) TO service_role, postgres;

COMMENT ON TABLE public.ses_report_trigger_settings IS
  'Single-row enable switch for the SES report-submitted drain (ses-report-trigger-drain cron). Independent of makesafe_cron_settings, which gates make-safe email polling only. Disable with UPDATE public.ses_report_trigger_settings SET drain_enabled = false, updated_by = <who>, updated_at = now(). Never DELETE the row: a missing row reads as off, but a re-apply of 20260911090000_ses_report_drain_own_flag re-seeds it as enabled.';
