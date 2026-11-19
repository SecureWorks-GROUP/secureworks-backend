-- Rollback of 20261119091700_cost_watchdog_trip_audit.
-- Puts each director watchdog command back to the statement this migration
-- replaced, then drops the trip audit. Timers stay, with the same schedule
-- and active flag. No switch is turned on. A command this migration did not
-- write refuses before anything is dropped.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $wire$
DECLARE
  profit constant text := $profit$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'job_profit_refresh_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$profit$;
  matcher constant text := $matcher$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'reconcile_matcher_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$matcher$;
  pages_live constant text := $live$select cron.alter_job(job_id := j.jobid, active := false) from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)$live$;
  pages_traced constant text := $traced$with paused as (select cron.alter_job(job_id := j.jobid, active := false), (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)) insert into public.job_watchdog_trips(guard, tripped_at, over30s, conns, trips) select 'job-pages-watchdog', now(), p.slow, p.conns, 1 from paused p on conflict (guard) do update set tripped_at = excluded.tripped_at, over30s = excluded.over30s, conns = excluded.conns, trips = public.job_watchdog_trips.trips + 1$traced$;
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
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR g IN SELECT * FROM (VALUES
      ('job-profit-watchdog', profit),
      ('job-matcher-watchdog', matcher),
      ('job-pages-watchdog', pages_traced)
    ) AS v(name, want) LOOP
      v_new := format('select public.director_cost_watchdog_tick(%L)', g.name);
      SELECT count(*) INTO n FROM cron.job
       WHERE jobname = g.name AND database = current_database();
      IF n > 1 THEN
        RAISE EXCEPTION 'director cost watchdog: % has % timers; refusing', g.name, n;
      END IF;
      IF n = 1 THEN
        SELECT command INTO v_cmd FROM cron.job
         WHERE jobname = g.name AND database = current_database();
        IF v_cmd IS DISTINCT FROM v_new AND v_cmd IS DISTINCT FROM g.want THEN
          RAISE EXCEPTION 'director cost watchdog: % runs a different statement; refusing to replace it', g.name;
        END IF;
      END IF;
    END LOOP;
    FOR g IN SELECT * FROM (VALUES
      ('job-profit-watchdog', profit),
      ('job-matcher-watchdog', matcher),
      ('job-pages-watchdog', pages_traced)
    ) AS v(name, want) LOOP
      v_new := format('select public.director_cost_watchdog_tick(%L)', g.name);
      SELECT count(*) INTO n FROM cron.job
       WHERE jobname = g.name AND database = current_database();
      IF n = 0 THEN
        CONTINUE;
      END IF;
      SELECT jobid, command INTO STRICT v_id, v_cmd FROM cron.job
       WHERE jobname = g.name AND database = current_database();
      IF v_cmd = v_new THEN
        PERFORM cron.alter_job(job_id := v_id, command := g.want);
      END IF;
    END LOOP;
  END IF;
  -- Reached only after every command check passed. A refusal above leaves
  -- the trip audit in place.
  DROP FUNCTION IF EXISTS public.cost_watchdog_switches();
  DROP FUNCTION IF EXISTS public.director_cost_watchdog_tick(text);
  IF to_regclass('public.ai_alerts') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ai_alerts'
         AND column_name = 'alert_type'
     ) THEN
    DELETE FROM public.ai_alerts WHERE alert_type = 'cost_watchdog_trip';
  END IF;
  DROP TABLE IF EXISTS public.cost_watchdog_trips;
END
$wire$;
