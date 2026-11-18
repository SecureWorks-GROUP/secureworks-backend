-- The director's three cost-chain guards (part of SEC-470). Only the pg_cron
-- catalog and API are simulated; the guards' stored statements are executed
-- against a shadow pg_stat_activity, so a trip and a quiet minute are both real.
BEGIN;
CREATE FUNCTION pg_temp.zz_assert(ok boolean, what text) RETURNS void LANGUAGE plpgsql AS $a$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'director watchdogs contract: %', what; END IF; END $a$;

-- The walk applied the migration with no pg_cron: the trace table only.
SELECT pg_temp.zz_assert(to_regclass('public.job_watchdog_trips') IS NOT NULL, 'trace table');
SELECT pg_temp.zz_assert(NOT has_table_privilege('anon','public.job_watchdog_trips','SELECT')
  AND NOT has_table_privilege('authenticated','public.job_watchdog_trips','SELECT'), 'trace table is private');
SELECT pg_temp.zz_assert((SELECT relrowsecurity FROM pg_class WHERE oid='public.job_watchdog_trips'::regclass), 'trace RLS');

CREATE TEMP TABLE zz_s(name text PRIMARY KEY, sql text);
INSERT INTO zz_s VALUES
 ('profit', $cmd$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'job_profit_refresh_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$cmd$),
 ('pages', $cmd$select cron.alter_job(job_id := j.jobid, active := false) from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)$cmd$),
 ('matcher', $cmd$update public.feature_flags f set enabled = false, updated_at = now(), description = left(coalesce(f.description,''), 300) || ' [auto-off by watchdog ' || to_char(now() at time zone 'Australia/Perth','DD Mon HH24:MI') || ' over30s=' || s.slow || ' conns=' || s.conns || ']' from (select (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns) s where f.flag_name = 'reconcile_matcher_v1' and f.enabled and (s.slow >= 4 or s.conns >= 120)$cmd$),
 ('traced', $cmd$with paused as (select cron.alter_job(job_id := j.jobid, active := false), (select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') as slow, (select count(*) from pg_stat_activity) as conns from cron.job j where j.jobname = 'job-pages-refresh' and j.database = current_database() and j.active and ((select count(*) from pg_stat_activity where backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '30 seconds') >= 4 or (select count(*) from pg_stat_activity) >= 120)) insert into public.job_watchdog_trips(guard, tripped_at, over30s, conns, trips) select 'job-pages-watchdog', now(), p.slow, p.conns, 1 from paused p on conflict (guard) do update set tripped_at = excluded.tripped_at, over30s = excluded.over30s, conns = excluded.conns, trips = public.job_watchdog_trips.trips + 1$cmd$);
CREATE FUNCTION pg_temp.s(p text) RETURNS text LANGUAGE sql AS $f$ SELECT sql FROM pg_temp.zz_s WHERE name = p $f$;

CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, jobname text, database text DEFAULT current_database(),
 command text, active boolean DEFAULT true, schedule text);
SELECT setval('cron.job_jobid_seq', 100);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $stub$
 INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid
$stub$;
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
 database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $stub$
 UPDATE cron.job SET schedule=coalesce($2,schedule), command=coalesce($3,command),
  database=coalesce($4,database), active=coalesce($6,active) WHERE jobid=$1
$stub$;
CREATE TABLE pg_temp.zz_snap AS SELECT * FROM cron.job WHERE false;
CREATE FUNCTION pg_temp.snap() RETURNS void LANGUAGE sql AS $f$
 DELETE FROM pg_temp.zz_snap; INSERT INTO pg_temp.zz_snap SELECT * FROM cron.job $f$;
CREATE FUNCTION pg_temp.unchanged() RETURNS boolean LANGUAGE sql AS $f$
 SELECT NOT EXISTS (SELECT * FROM cron.job EXCEPT SELECT * FROM pg_temp.zz_snap)
    AND NOT EXISTS (SELECT * FROM pg_temp.zz_snap EXCEPT SELECT * FROM cron.job) $f$;
CREATE FUNCTION pg_temp.cmd(p text) RETURNS text LANGUAGE sql AS $f$ SELECT command FROM cron.job WHERE jobname = p $f$;

-- 1. Absent: all three installed, every minute, active; the page guard with its trace.
\ir ../../../migrations/20261119999941_director_cost_watchdogs.sql
SELECT pg_temp.zz_assert((SELECT count(*) FROM cron.job) = 3
  AND pg_temp.cmd('job-profit-watchdog') = pg_temp.s('profit')
  AND pg_temp.cmd('job-pages-watchdog') = pg_temp.s('traced')
  AND pg_temp.cmd('job-matcher-watchdog') = pg_temp.s('matcher')
  AND NOT EXISTS (SELECT FROM cron.job WHERE schedule <> '* * * * *' OR NOT active), 'absent: installed');
SELECT pg_temp.snap();
\ir ../../../migrations/20261119999941_director_cost_watchdogs.sql
SELECT pg_temp.zz_assert(pg_temp.unchanged(), 're-apply changes nothing');

-- 2. Present with exactly the live statements (the live case): the two switch
-- guards are left; the page guard's statement changes in place, same id and
-- active state; an inactive guard stays inactive; other timers are not read.
DELETE FROM cron.job;
INSERT INTO cron.job(jobid,jobname,command,active,schedule) VALUES
 (21,'job-profit-watchdog',pg_temp.s('profit'),true,'* * * * *'),
 (22,'job-pages-watchdog',pg_temp.s('pages'),false,'* * * * *'),
 (23,'job-matcher-watchdog',pg_temp.s('matcher'),false,'* * * * *'),
 (24,'job-pages-refresh','SELECT 1',true,'* * * * *'),
 (25,'job-profit-watchdog','SELECT 1',true,'* * * * *');
UPDATE cron.job SET database = 'zz_other_database' WHERE jobid = 25;
SELECT pg_temp.snap();
\ir ../../../migrations/20261119999941_director_cost_watchdogs.sql
SELECT pg_temp.zz_assert(
  NOT EXISTS (SELECT * FROM cron.job WHERE jobid <> 22 EXCEPT SELECT * FROM pg_temp.zz_snap)
  AND EXISTS (SELECT FROM cron.job WHERE jobid = 22 AND jobname = 'job-pages-watchdog'
     AND command = pg_temp.s('traced') AND NOT active AND schedule = '* * * * *')
  AND (SELECT count(*) FROM cron.job) = 5, 'exact: switch guards left, page guard traced in place');

-- 3. A different statement on any guard refuses, and nothing changes (checked
-- before any change, so the page guard is not traced either).
UPDATE cron.job SET command = pg_temp.s('pages') WHERE jobid = 22;
UPDATE cron.job SET command = pg_temp.s('profit') || ' ' WHERE jobid = 21;
SELECT pg_temp.snap();
SAVEPOINT different;
\set ON_ERROR_STOP off
\ir ../../../migrations/20261119999941_director_cost_watchdogs.sql
\set different_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO different;
SELECT pg_temp.zz_assert(:'different_state' = 'P0001', 'different: must refuse, got ' || :'different_state');
SELECT pg_temp.zz_assert(pg_temp.unchanged(), 'different: nothing changed');
UPDATE cron.job SET command = pg_temp.s('profit') WHERE jobid = 21;
UPDATE cron.job SET command = 'SELECT 1' WHERE jobid = 22;
SELECT pg_temp.snap();
SAVEPOINT different_pages;
\set ON_ERROR_STOP off
\ir ../../../migrations/20261119999941_director_cost_watchdogs.sql
\set different_pages_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO different_pages;
SELECT pg_temp.zz_assert(:'different_pages_state' = 'P0001', 'different_pages: must refuse, got ' || :'different_pages_state');
SELECT pg_temp.zz_assert(pg_temp.unchanged(), 'different page guard: nothing changed');
UPDATE cron.job SET command = pg_temp.s('pages') WHERE jobid = 22;

-- 4. Two timers with one name refuse.
INSERT INTO cron.job(jobid,jobname,command,active,schedule) VALUES (26,'job-matcher-watchdog',pg_temp.s('matcher'),true,'* * * * *');
SELECT pg_temp.snap();
SAVEPOINT duplicate;
\set ON_ERROR_STOP off
\ir ../../../migrations/20261119999941_director_cost_watchdogs.sql
\set duplicate_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO duplicate;
SELECT pg_temp.zz_assert(:'duplicate_state' = 'P0001', 'duplicate: must refuse, got ' || :'duplicate_state');
SELECT pg_temp.zz_assert(pg_temp.unchanged(), 'duplicate: nothing changed');
DELETE FROM cron.job WHERE jobid IN (25, 26);

-- 5. The guards' statements, run as the timer runs them, against a shadow
-- pg_stat_activity (temp relations are searched first).
CREATE TEMP TABLE zz_activity(backend_type text, state text, pid integer, query_start timestamptz);
CREATE TEMP VIEW pg_stat_activity AS SELECT * FROM pg_temp.zz_activity;
\ir ../../../migrations/20261119999941_director_cost_watchdogs.sql
DELETE FROM public.job_watchdog_trips;
UPDATE cron.job SET active = true WHERE jobid IN (22, 24);
-- Quiet: 3 slow queries, 3 connections. Nothing moves.
INSERT INTO zz_activity SELECT 'client backend','active',-n,now() - interval '31 seconds' FROM generate_series(1,3) n;
SELECT command FROM cron.job WHERE jobid = 22 \gexec
SELECT pg_temp.zz_assert((SELECT active FROM cron.job WHERE jobid = 24)
  AND NOT EXISTS (SELECT FROM public.job_watchdog_trips), 'quiet: page refresh stays on, no trace');
-- Strain: a 4th slow query. The page refresh pauses and the trace says when and why.
INSERT INTO zz_activity VALUES ('client backend','active',-4,now() - interval '31 seconds');
SELECT command FROM cron.job WHERE jobid = 22 \gexec
SELECT pg_temp.zz_assert(NOT (SELECT active FROM cron.job WHERE jobid = 24)
  AND EXISTS (SELECT FROM public.job_watchdog_trips WHERE guard = 'job-pages-watchdog'
    AND over30s = 4 AND conns = 4 AND trips = 1 AND tripped_at = now()), 'strain: paused, traced');
-- Already paused: nothing more (the trace counts pauses, not strained minutes).
SELECT command FROM cron.job WHERE jobid = 22 \gexec
SELECT pg_temp.zz_assert((SELECT trips FROM public.job_watchdog_trips) = 1, 'already paused: no new trace');
-- On again and 120 connections: paused again, the count moves on.
UPDATE cron.job SET active = true WHERE jobid = 24;
DELETE FROM zz_activity;
INSERT INTO zz_activity SELECT 'client backend','idle',-n,now() FROM generate_series(1,120) n;
SELECT command FROM cron.job WHERE jobid = 22 \gexec
SELECT pg_temp.zz_assert(NOT (SELECT active FROM cron.job WHERE jobid = 24)
  AND (SELECT (trips, over30s, conns) FROM public.job_watchdog_trips) = (2::bigint, 0::bigint, 120::bigint), '120 connections: paused, counted');
-- The two switch guards, unchanged, still turn their switch off and write the trace.
UPDATE public.feature_flags SET enabled = true WHERE flag_name IN ('job_profit_refresh_v1','reconcile_matcher_v1');
SELECT command FROM cron.job WHERE jobid IN (21, 23) ORDER BY jobid \gexec
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT FROM public.feature_flags
   WHERE flag_name IN ('job_profit_refresh_v1','reconcile_matcher_v1')
     AND (enabled OR description NOT LIKE '%[auto-off by watchdog % over30s=0 conns=120]')), 'switch guards: off, traced');
-- Nothing turns anything back on: under no strain, an off switch and a paused refresh stay so.
DELETE FROM zz_activity;
SELECT command FROM cron.job WHERE jobid IN (21, 22, 23) ORDER BY jobid \gexec
SELECT pg_temp.zz_assert(NOT (SELECT active FROM cron.job WHERE jobid = 24)
  AND NOT EXISTS (SELECT FROM public.feature_flags WHERE flag_name IN ('job_profit_refresh_v1','reconcile_matcher_v1') AND enabled),
  'nothing turns back on');
DROP VIEW pg_stat_activity;

-- 6. Rollback: the page guard gets the director's statement back in place (same
-- id, active state), the switch guards and timers stay, the trace table goes.
UPDATE cron.job SET active = false WHERE jobid = 22;
\ir ../../../rollbacks/20261119999941_director_cost_watchdogs_down.sql
SELECT pg_temp.zz_assert(EXISTS (SELECT FROM cron.job WHERE jobid = 22 AND command = pg_temp.s('pages') AND NOT active)
  AND pg_temp.cmd('job-profit-watchdog') = pg_temp.s('profit')
  AND pg_temp.cmd('job-matcher-watchdog') = pg_temp.s('matcher')
  AND to_regclass('public.job_watchdog_trips') IS NULL, 'rollback restores the live statement');
\ir ../../../rollbacks/20261119999941_director_cost_watchdogs_down.sql
SELECT pg_temp.zz_assert(pg_temp.cmd('job-pages-watchdog') = pg_temp.s('pages'), 'rollback re-run');
-- The rollback carries the same guard.
UPDATE cron.job SET command = 'SELECT 1' WHERE jobid = 23;
SELECT pg_temp.snap();
SAVEPOINT rollback_different;
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261119999941_director_cost_watchdogs_down.sql
\set rollback_different_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO rollback_different;
SELECT pg_temp.zz_assert(:'rollback_different_state' = 'P0001', 'rollback_different: must refuse, got ' || :'rollback_different_state');
SELECT pg_temp.zz_assert(pg_temp.unchanged(), 'rollback different: nothing changed');
UPDATE cron.job SET command = pg_temp.s('matcher') WHERE jobid = 23;
-- Round trip: apply again after the rollback.
\ir ../../../migrations/20261119999941_director_cost_watchdogs.sql
SELECT pg_temp.zz_assert(EXISTS (SELECT FROM cron.job WHERE jobid = 22 AND command = pg_temp.s('traced'))
  AND to_regclass('public.job_watchdog_trips') IS NOT NULL, 'round trip');

ROLLBACK;
\echo 'PASS: director watchdogs install only when absent, leave an exact one, trace the page guard in place, refuse a different or duplicated one, and roll back to the live statement.'
