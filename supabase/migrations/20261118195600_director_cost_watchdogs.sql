-- The director's three cost-chain guards, filed (part of SEC-470). Placeholder
-- migration number; the keeper stamps it.
--
-- On live since 19 Nov, every minute, one shared strain test (4 or more client
-- queries active for over 30 seconds, or 120 or more connections):
--   job-profit-watchdog   turns job_profit_refresh_v1 off
--   job-pages-watchdog    pauses the job-pages-refresh timer
--   job-matcher-watchdog  turns reconcile_matcher_v1 off
-- None turns anything back on.
--
-- Each timer is installed only when absent. One present with exactly the
-- director's statement is left as it is (same id, schedule, active state and
-- history). The one change: the page guard gains a readable trace (the two
-- switch guards already write theirs into the switch's description). Its live
-- statement is changed in place to the traced one, with the same WHERE and
-- strain test, word for word. Any other statement, or two timers with one
-- name, refuses before anything changes. The rollback carries the same guard.
--
-- Director's ask over merge-safety rule 2 (no schedule from a migration): on
-- live all three exist, so this installs none there; it installs only on a
-- database that lacks them. Without pg_cron the timer part does nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The page guard's trace: one row per guard, the last trip, and how many.
-- It never grows past one row a guard, so it needs no trim.
CREATE TABLE IF NOT EXISTS public.job_watchdog_trips (
 guard text PRIMARY KEY,
 tripped_at timestamptz NOT NULL,
 over30s bigint NOT NULL,
 conns bigint NOT NULL,
 trips bigint NOT NULL DEFAULT 1
);
ALTER TABLE public.job_watchdog_trips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_watchdog_trips FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_watchdog_trips TO service_role;

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
 v_id bigint;
 v_cmd text;
/* migration block */ BEGIN
 -- The four statements above are pinned by md5: an edit to any of them refuses.
 IF md5(profit) <> '3e2257bc5622e26f37b36e44b1c48b90' OR md5(pages_live) <> '02f234711d2fdd72d05cf1c95e5523a8'
    OR md5(matcher) <> 'b69012508de0a1d041a186b91817175e' OR md5(pages_traced) <> '24fe57c8917e81268c823db6b98955fb' THEN
  RAISE EXCEPTION 'director watchdogs: a pinned statement was edited';
 END IF;
 IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
 -- Check every guard first: a refusal leaves all three as they were.
 FOR g IN SELECT * FROM (VALUES
   ('job-profit-watchdog', profit, NULL::text),
   ('job-pages-watchdog', pages_traced, pages_live),
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
 FOR g IN SELECT * FROM (VALUES
   ('job-profit-watchdog', profit, NULL::text),
   ('job-pages-watchdog', pages_traced, pages_live),
   ('job-matcher-watchdog', matcher, NULL::text)) AS v(name, want, earlier) LOOP
  /* lookup */ BEGIN
   SELECT jobid, command INTO STRICT v_id, v_cmd
     FROM cron.job WHERE jobname = g.name AND database = current_database();
  EXCEPTION WHEN no_data_found THEN
   PERFORM cron.schedule(g.name, '* * * * *', g.want);
   CONTINUE;
  END;
  IF v_cmd = g.earlier THEN
   PERFORM cron.alter_job(job_id := v_id, command := g.want);
  END IF;
 END LOOP;
END $guards$;
