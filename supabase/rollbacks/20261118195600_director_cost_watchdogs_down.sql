-- Rollback of 20261118195600_director_cost_watchdogs: the page guard gets back the
-- director's statement in place (same id, active state and history), then the
-- trace table goes. The timers stay: they were on live before this was filed,
-- and removing one would strip protection. Same guard as the migration: any
-- other statement, or two timers with one name, refuses before anything changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guards$
DECLARE
 -- The director's live statements, byte for byte (read from live 19 Nov 02:57).
 profit constant text := $cmd$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'job_profit_refresh_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$cmd$;
 pages_live constant text := $cmd$select cron.alter_job(job_id := j.jobid, active := false) from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)$cmd$;
 matcher constant text := $cmd$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'reconcile_matcher_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$cmd$;
 -- The page guard with its trace: the live statement's WHERE, verbatim, in a CTE.
 pages_traced constant text := $cmd$with paused as (select cron.alter_job(job_id := j.jobid, active := false), (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)) insert into public.job_watchdog_trips(guard, tripped_at, over30s, conns, trips) select 'job-pages-watchdog', now(), p.slow, p.conns, 1 from paused p on conflict (guard) do update set tripped_at = excluded.tripped_at, over30s = excluded.over30s, conns = excluded.conns, trips = public.job_watchdog_trips.trips + 1$cmd$;
 g record;
 n integer;
/* rollback block */ BEGIN
 -- The four statements above are pinned by md5: an edit to any of them refuses.
 IF md5(profit) <> '3e2257bc5622e26f37b36e44b1c48b90' OR md5(pages_live) <> '02f234711d2fdd72d05cf1c95e5523a8'
    OR md5(matcher) <> 'b69012508de0a1d041a186b91817175e' OR md5(pages_traced) <> '24fe57c8917e81268c823db6b98955fb' THEN
  RAISE EXCEPTION 'director watchdogs: a pinned statement was edited';
 END IF;
 IF to_regclass('cron.job') IS NULL THEN
  DROP TABLE IF EXISTS public.job_watchdog_trips;
  RETURN;
 END IF;
 FOR g IN SELECT * FROM (VALUES
   ('job-profit-watchdog', profit, NULL::text),
   ('job-pages-watchdog', pages_live, pages_traced),
   ('job-matcher-watchdog', matcher, NULL::text)) AS v(name, want, earlier) LOOP
  SELECT count(*) INTO n FROM cron.job WHERE jobname = g.name AND database = current_database();
  IF n > 1 THEN
   RAISE EXCEPTION 'director watchdogs: % has % timers; refusing', g.name, n;
  END IF;
  IF n = 1 AND NOT EXISTS (
   SELECT FROM cron.job WHERE jobname = g.name AND database = current_database()
     AND (command = g.want OR command = g.earlier)) THEN
   RAISE EXCEPTION 'director watchdogs: % runs a different statement; refusing to replace it', g.name;
  END IF;
 END LOOP;
 PERFORM cron.alter_job(job_id := j.jobid, command := pages_live)
   FROM cron.job j
  WHERE j.jobname = 'job-pages-watchdog' AND j.database = current_database()
    AND j.command = pages_traced;
 -- After the page guard no longer writes to it.
 DROP TABLE IF EXISTS public.job_watchdog_trips;
END $guards$;
