-- P0-01.2: bounded page refresh in the database, with no outside caller.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.job_pages_keep_ready_set() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT jb.id FROM public.jobs jb
 WHERE jb.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
    OR (jb.status::text IN ('cancelled','archived','complete','completed','lost')
        AND greatest(coalesce(jb.completed_at,'-infinity'),coalesce(jb.updated_at,'-infinity')) > now() - interval '12 months')
$fn$;

CREATE OR REPLACE FUNCTION public.job_pages_nightly(p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_id uuid; v_marked integer := 0; v_deleted integer;
BEGIN
 FOR v_id IN SELECT k.id FROM public.job_pages_keep_ready_set() AS k(id)
  LEFT JOIN public.job_pages p ON p.job_id=k.id
  WHERE p.job_id IS NULL OR p.page_version < public.job_page_version() OR p.status='failed'
  ORDER BY k.id LIMIT greatest(0,least(coalesce(p_limit,200),200))
 LOOP
  PERFORM public.job_mark_changed(v_id,'status');
  v_marked := v_marked + 1;
 END LOOP;
 DELETE FROM public.job_pages WHERE job_id NOT IN (SELECT public.job_pages_keep_ready_set())
  AND built_at < now() - interval '7 days';
 GET DIAGNOSTICS v_deleted = ROW_COUNT;
 RETURN jsonb_build_object('marked',v_marked,'deleted',v_deleted);
END $fn$;

REVOKE ALL ON FUNCTION public.job_pages_keep_ready_set() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_pages_keep_ready_set() TO service_role;
REVOKE ALL ON FUNCTION public.job_pages_nightly(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_pages_nightly(integer) TO service_role;

-- No pg_cron in the disposable contract stack: leave schedules absent there.
DO $cron$
DECLARE v_job bigint;
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'job pages: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN ('job-pages-refresh','job-pages-nightly') LOOP
  PERFORM cron.unschedule(v_job);
 END LOOP;
 PERFORM cron.schedule('job-pages-refresh','* * * * *',
  $cmd$SET LOCAL statement_timeout = '50s'; SELECT public.job_pages_refresh_due(5);$cmd$);
 PERFORM cron.schedule('job-pages-nightly','10 18 * * *',
  $cmd$SELECT public.job_pages_nightly(200);$cmd$);
END $cron$;
