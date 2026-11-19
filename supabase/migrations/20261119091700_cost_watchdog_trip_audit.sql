-- Cost watchdog trip audit.
-- A director cost watchdog that turns a switch off also writes one
-- cost_watchdog_trips row and, when ai_alerts can take it, one ops alert.
-- The off-switch statement and its strain test are the statements already
-- installed (pinned by md5). Nothing is turned back on. No timer is
-- scheduled or rescheduled. An alert-table failure cannot undo the off switch.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.cost_watchdog_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  watchdog_name text NOT NULL,
  switch_key text NOT NULL,
  previous_value boolean,
  new_value boolean NOT NULL DEFAULT false,
  metric_name text,
  metric_value numeric,
  threshold numeric,
  reason text NOT NULL,
  tripped_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  ack_note text
);

CREATE INDEX IF NOT EXISTS cost_watchdog_trips_tripped_at_idx
  ON public.cost_watchdog_trips (tripped_at DESC);
CREATE INDEX IF NOT EXISTS cost_watchdog_trips_switch_tripped_at_idx
  ON public.cost_watchdog_trips (switch_key, tripped_at DESC);

ALTER TABLE public.cost_watchdog_trips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_watchdog_trips FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cost_watchdog_trips TO service_role;

CREATE OR REPLACE FUNCTION public.director_cost_watchdog_tick(p_guard text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_temp, pg_catalog, public, cron
AS $tick$
DECLARE
  v_sql text;
  v_n integer;
  v_slow bigint;
  v_conns bigint;
  v_switch text;
  v_metric text;
  v_value numeric;
  v_threshold numeric;
  v_reason text;
  v_id uuid;
  profit constant text := $profit$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'job_profit_refresh_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$profit$;
  matcher constant text := $matcher$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'reconcile_matcher_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$matcher$;
  pages constant text := $pages$with paused as (select cron.alter_job(job_id := j.jobid, active := false), (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)) insert into public.job_watchdog_trips(guard, tripped_at, over30s, conns, trips) select 'job-pages-watchdog', now(), p.slow, p.conns, 1 from paused p on conflict (guard) do update set tripped_at = excluded.tripped_at, over30s = excluded.over30s, conns = excluded.conns, trips = public.job_watchdog_trips.trips + 1$pages$;
BEGIN
  IF p_guard = 'job-profit-watchdog' THEN
    v_sql := profit;
    v_switch := 'job_profit_refresh_v1';
  ELSIF p_guard = 'job-matcher-watchdog' THEN
    v_sql := matcher;
    v_switch := 'reconcile_matcher_v1';
  ELSIF p_guard = 'job-pages-watchdog' THEN
    v_sql := pages;
    v_switch := 'job-pages-refresh';
  ELSE
    RAISE EXCEPTION 'director cost watchdog: unknown guard %', p_guard;
  END IF;
  -- pg_temp is named before pg_catalog so a contract can shadow
  -- pg_stat_activity. A cron session has no such view, so the real one is read.
  EXECUTE v_sql;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n < 1 THEN
    RETURN;
  END IF;
  -- The off switch above has already run. A failure in this block must not
  -- roll it back: the alert insert is best-effort, and a trip-table problem
  -- is swallowed for the same reason.
  BEGIN
    SELECT
      (SELECT count(*) FROM pg_stat_activity
        WHERE backend_type = 'client backend' AND state = 'active'
          AND pid <> pg_backend_pid()
          AND now() - query_start > interval '30 seconds'),
      (SELECT count(*) FROM pg_stat_activity)
      INTO v_slow, v_conns;
    IF v_slow >= 4 THEN
      v_metric := 'over30s';
      v_value := v_slow;
      v_threshold := 4;
    ELSE
      v_metric := 'conns';
      v_value := v_conns;
      v_threshold := 120;
    END IF;
    v_reason := p_guard || ' turned ' || v_switch
      || ' off under load: over30s=' || v_slow::text
      || ' (threshold 4), conns=' || v_conns::text
      || ' (threshold 120).';
    INSERT INTO public.cost_watchdog_trips (
      watchdog_name, switch_key, previous_value, new_value,
      metric_name, metric_value, threshold, reason
    ) VALUES (
      p_guard, v_switch, true, false,
      v_metric, v_value, v_threshold, v_reason
    ) RETURNING id INTO v_id;
    BEGIN
      IF to_regclass('public.ai_alerts') IS NOT NULL
         AND (
           SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'ai_alerts'
             AND column_name IN ('alert_type', 'severity', 'message')
         ) = 3
      THEN
        INSERT INTO public.ai_alerts (
          alert_type, severity, message, recommended_action, detail_json
        ) VALUES (
          'cost_watchdog_trip',
          'amber',
          v_reason,
          'The switch stays off until someone turns it back on.',
          jsonb_build_object(
            'trip_id', v_id,
            'watchdog_name', p_guard,
            'switch_key', v_switch,
            'metric_name', v_metric,
            'metric_value', v_value,
            'threshold', v_threshold
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END
$tick$;

CREATE OR REPLACE FUNCTION public.cost_watchdog_switches()
RETURNS TABLE(key text, enabled boolean, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $sw$
DECLARE
  v_enabled boolean;
  v_n integer;
BEGIN
  RETURN QUERY
  SELECT w.flag_name, f.enabled, f.updated_at
  FROM (VALUES
    ('job_profit_refresh_v1'::text),
    ('reconcile_matcher_v1'::text)
  ) AS w(flag_name)
  LEFT JOIN public.feature_flags f ON f.flag_name = w.flag_name
  ORDER BY w.flag_name;
  IF to_regclass('cron.job') IS NULL THEN
    RETURN QUERY SELECT 'job-pages-refresh'::text, NULL::boolean, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT count(*)::integer, bool_and(j.active)
    INTO v_n, v_enabled
  FROM cron.job j
  WHERE j.jobname = 'job-pages-refresh' AND j.database = current_database();
  IF v_n IS DISTINCT FROM 1 THEN
    v_enabled := NULL;
  END IF;
  RETURN QUERY SELECT 'job-pages-refresh'::text, v_enabled, NULL::timestamptz;
END
$sw$;

REVOKE ALL ON FUNCTION public.director_cost_watchdog_tick(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cost_watchdog_switches() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cost_watchdog_switches() TO service_role;
GRANT EXECUTE ON FUNCTION public.director_cost_watchdog_tick(text) TO CURRENT_USER;

DO $wire$
DECLARE
  profit constant text := $profit$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'job_profit_refresh_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$profit$;
  matcher constant text := $matcher$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'reconcile_matcher_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$matcher$;
  pages_live constant text := $live$select cron.alter_job(job_id := j.jobid, active := false) from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)$live$;
  pages_traced constant text := $traced$with paused as (select cron.alter_job(job_id := j.jobid, active := false), (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)) insert into public.job_watchdog_trips(guard, tripped_at, over30s, conns, trips) select 'job-pages-watchdog', now(), p.slow, p.conns, 1 from paused p on conflict (guard) do update set tripped_at = excluded.tripped_at, over30s = excluded.over30s, conns = excluded.conns, trips = public.job_watchdog_trips.trips + 1$traced$;
  def text;
  g record;
  n integer;
  v_id bigint;
  v_cmd text;
  v_new text;
BEGIN
  IF md5(profit) <> '3e2257bc5622e26f37b36e44b1c48b90'
     OR md5(matcher) <> 'b69012508de0a1d041a186b91817175e'
     OR md5(pages_live) <> '02f234711d2fdd72d05cf1c95e5523a8'
     OR md5(pages_traced) <> '24fe57c8917e81268c823db6b98955fb' THEN
    RAISE EXCEPTION 'director cost watchdog: a pinned statement was edited';
  END IF;
  def := pg_get_functiondef('public.director_cost_watchdog_tick(text)'::regprocedure);
  IF position(profit IN def) = 0 OR position(matcher IN def) = 0
     OR position(pages_traced IN def) = 0 THEN
    RAISE EXCEPTION 'director cost watchdog: the tick lost a pinned statement';
  END IF;
  IF position('enabled = true' IN def) > 0 OR position('active := true' IN def) > 0 THEN
    RAISE EXCEPTION 'director cost watchdog: the tick must not turn a switch on';
  END IF;
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  -- Check every guard before changing any command.
  FOR g IN SELECT * FROM (VALUES
    ('job-profit-watchdog', profit, NULL::text),
    ('job-matcher-watchdog', matcher, NULL::text),
    ('job-pages-watchdog', pages_traced, pages_live)
  ) AS v(name, want, earlier) LOOP
    v_new := format('select public.director_cost_watchdog_tick(%L)', g.name);
    SELECT count(*) INTO n FROM cron.job
     WHERE jobname = g.name AND database = current_database();
    IF n > 1 THEN
      RAISE EXCEPTION 'director cost watchdog: % has % timers; refusing', g.name, n;
    END IF;
    IF n = 1 THEN
      SELECT command INTO v_cmd FROM cron.job
       WHERE jobname = g.name AND database = current_database();
      IF v_cmd IS DISTINCT FROM v_new
         AND v_cmd IS DISTINCT FROM g.want
         AND v_cmd IS DISTINCT FROM g.earlier THEN
        RAISE EXCEPTION 'director cost watchdog: % runs a different statement; refusing to replace it', g.name;
      END IF;
    END IF;
  END LOOP;
  FOR g IN SELECT * FROM (VALUES
    ('job-profit-watchdog', profit, NULL::text),
    ('job-matcher-watchdog', matcher, NULL::text),
    ('job-pages-watchdog', pages_traced, pages_live)
  ) AS v(name, want, earlier) LOOP
    v_new := format('select public.director_cost_watchdog_tick(%L)', g.name);
    SELECT count(*) INTO n FROM cron.job
     WHERE jobname = g.name AND database = current_database();
    IF n = 0 THEN
      CONTINUE;
    END IF;
    SELECT jobid, command INTO STRICT v_id, v_cmd FROM cron.job
     WHERE jobname = g.name AND database = current_database();
    IF v_cmd = v_new THEN
      CONTINUE;
    END IF;
    PERFORM cron.alter_job(job_id := v_id, command := v_new);
    BEGIN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.director_cost_watchdog_tick(text) TO %I',
        (SELECT username FROM cron.job WHERE jobid = v_id)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END
$wire$;
