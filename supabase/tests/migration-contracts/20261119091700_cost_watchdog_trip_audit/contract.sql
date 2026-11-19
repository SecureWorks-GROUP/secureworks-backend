-- A director cost watchdog that turns a switch off writes a trip and, when
-- ai_alerts can take one, an ops alert. The strain test stays the installed
-- statement: 3 slow queries and 119 connections do nothing; 4 slow queries
-- and 120 connections turn the switch off. Nothing turns a switch on.
BEGIN;
CREATE FUNCTION pg_temp.zz_assert(ok boolean, what text) RETURNS void LANGUAGE plpgsql AS $a$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'cost watchdog contract: %', what; END IF; END $a$;

-- The break proof weakens the tick first. This check has to fail before any
-- later setup, so a weakened threshold cannot look like a passing contract.
DO $verbatim$
DECLARE
  def text := pg_get_functiondef('public.director_cost_watchdog_tick(text)'::regprocedure);
  phrase constant text := 's.slow >= 4 or s.conns >= 120';
  n integer;
BEGIN
  n := (length(def) - length(replace(def, phrase, ''))) / length(phrase);
  IF n <> 2
     OR position('30 seconds' IN def) = 0
     OR position('>= 120' IN def) = 0
     OR position('job_profit_refresh_v1' IN def) = 0
     OR position('reconcile_matcher_v1' IN def) = 0
     OR position('enabled = false' IN def) = 0
     OR position('active := false' IN def) = 0
     OR position('enabled = true' IN def) > 0
     OR position('active := true' IN def) > 0 THEN
    RAISE EXCEPTION 'cost watchdog contract: threshold verbatim missing';
  END IF;
END
$verbatim$;

SELECT pg_temp.zz_assert(to_regclass('public.cost_watchdog_trips') IS NOT NULL, 'trip table');
SELECT pg_temp.zz_assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cost_watchdog_trips'::regclass), 'trip RLS');
SELECT pg_temp.zz_assert(
  NOT has_table_privilege('anon', 'public.cost_watchdog_trips', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.cost_watchdog_trips', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.cost_watchdog_trips', 'INSERT')
  AND has_table_privilege('service_role', 'public.cost_watchdog_trips', 'SELECT')
  AND has_table_privilege('service_role', 'public.cost_watchdog_trips', 'INSERT'),
  'trip table grants');
SELECT pg_temp.zz_assert(
  NOT has_function_privilege('anon', 'public.director_cost_watchdog_tick(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.director_cost_watchdog_tick(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.cost_watchdog_switches()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.cost_watchdog_switches()', 'EXECUTE'),
  'tick is not callable by anon; status read is');
SELECT pg_temp.zz_assert(
  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
    'cost_watchdog_trips_tripped_at_idx', 'cost_watchdog_trips_switch_tripped_at_idx'
  )) = 2, 'trip indexes');
SELECT pg_temp.zz_assert(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cost_watchdog_trips'
      AND column_name IN (
        'id','org_id','watchdog_name','switch_key','previous_value','new_value',
        'metric_name','metric_value','threshold','reason','tripped_at',
        'acknowledged_at','acknowledged_by','ack_note'
      )) = 14
  AND (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cost_watchdog_trips' AND column_name = 'reason') = 'NO'
  AND (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cost_watchdog_trips' AND column_name = 'new_value') LIKE '%false%',
  'trip columns');
SELECT pg_temp.zz_assert(to_regclass('public.job_watchdog_trips') IS NOT NULL, 'page trace table kept');

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('job_profit_refresh_v1', true, 'ZZTEST'),
       ('reconcile_matcher_v1', true, 'ZZTEST')
ON CONFLICT (flag_name) DO UPDATE SET enabled = true, description = 'ZZTEST';
SELECT pg_temp.zz_assert(
  (SELECT count(*) FROM public.cost_watchdog_switches() s
    WHERE s.key IN ('job_profit_refresh_v1', 'reconcile_matcher_v1') AND s.enabled)
  = 2
  AND EXISTS (
    SELECT 1 FROM public.cost_watchdog_switches() s
    WHERE s.key = 'job-pages-refresh' AND s.enabled IS NULL
  ),
  'switches before cron: flags on, pages unknown');

-- The statements the tick runs, read back out of the function, are the pinned ones.
CREATE FUNCTION pg_temp.pinned(which text) RETURNS text LANGUAGE plpgsql AS $p$
DECLARE
  def text := pg_get_functiondef('public.director_cost_watchdog_tick(text)'::regprocedure);
  tag text := '$' || which || '$';
  open_at integer;
  rest text;
  close_at integer;
BEGIN
  open_at := position(tag IN def);
  IF open_at = 0 THEN
    RAISE EXCEPTION 'cost watchdog contract: missing % tag', which;
  END IF;
  rest := substr(def, open_at + length(tag));
  close_at := position(tag IN rest);
  IF close_at = 0 THEN
    RAISE EXCEPTION 'cost watchdog contract: unclosed % tag', which;
  END IF;
  RETURN substr(rest, 1, close_at - 1);
END
$p$;
SELECT pg_temp.zz_assert(md5(pg_temp.pinned('profit')) = '3e2257bc5622e26f37b36e44b1c48b90', 'profit statement md5');
SELECT pg_temp.zz_assert(md5(pg_temp.pinned('matcher')) = 'b69012508de0a1d041a186b91817175e', 'matcher statement md5');
SELECT pg_temp.zz_assert(md5(pg_temp.pinned('pages')) = '24fe57c8917e81268c823db6b98955fb', 'pages statement md5');

CREATE SCHEMA cron;
CREATE TABLE cron.job(
  jobid bigserial PRIMARY KEY,
  jobname text,
  database text DEFAULT current_database(),
  command text,
  active boolean DEFAULT true,
  schedule text,
  username text
);
SELECT setval('cron.job_jobid_seq', 100);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $stub$
 INSERT INTO cron.job(jobname, schedule, command) VALUES ($1, $2, $3) RETURNING jobid
$stub$;
CREATE FUNCTION cron.alter_job(
  job_id bigint,
  schedule text DEFAULT NULL,
  command text DEFAULT NULL,
  database text DEFAULT NULL,
  username text DEFAULT NULL,
  active boolean DEFAULT NULL
) RETURNS void LANGUAGE sql AS $stub$
 UPDATE cron.job SET
   schedule = coalesce($2, schedule),
   command = coalesce($3, command),
   database = coalesce($4, database),
   username = coalesce($5, username),
   active = coalesce($6, active)
 WHERE jobid = $1
$stub$;

INSERT INTO cron.job(jobid, jobname, command, active, schedule, database) VALUES
 (21, 'job-profit-watchdog', pg_temp.pinned('profit'), true, '* * * * *', current_database()),
 (22, 'job-pages-watchdog', pg_temp.pinned('pages'), false, '* * * * *', current_database()),
 (23, 'job-matcher-watchdog', pg_temp.pinned('matcher'), true, '* * * * *', current_database()),
 (24, 'job-pages-refresh', 'SELECT 1', true, '* * * * *', current_database()),
 (25, 'job-profit-watchdog', 'SELECT 1', true, '* * * * *', 'zz_other_database');

\ir ../../../migrations/20261119091700_cost_watchdog_trip_audit.sql
SELECT pg_temp.zz_assert(
  (SELECT command FROM cron.job WHERE jobid = 21) = 'select public.director_cost_watchdog_tick(''job-profit-watchdog'')'
  AND (SELECT command FROM cron.job WHERE jobid = 23) = 'select public.director_cost_watchdog_tick(''job-matcher-watchdog'')'
  AND (SELECT command FROM cron.job WHERE jobid = 22) = 'select public.director_cost_watchdog_tick(''job-pages-watchdog'')'
  AND (SELECT command FROM cron.job WHERE jobid = 24) = 'SELECT 1'
  AND (SELECT command FROM cron.job WHERE jobid = 25) = 'SELECT 1'
  AND NOT (SELECT active FROM cron.job WHERE jobid = 22)
  AND (SELECT active FROM cron.job WHERE jobid = 21)
  AND (SELECT active FROM cron.job WHERE jobid = 24)
  AND NOT EXISTS (SELECT 1 FROM cron.job WHERE schedule IS DISTINCT FROM '* * * * *')
  AND NOT EXISTS (SELECT 1 FROM public.cost_watchdog_trips)
  AND NOT EXISTS (SELECT 1 FROM public.feature_flags
       WHERE flag_name IN ('job_profit_refresh_v1', 'reconcile_matcher_v1') AND NOT enabled),
  'upgrade replaces the command only');
SELECT pg_temp.zz_assert(
  (SELECT enabled FROM public.cost_watchdog_switches() WHERE key = 'job-pages-refresh'),
  'pages refresh still on');

CREATE TEMP TABLE zz_cron AS SELECT jobid, jobname, database, command, active, schedule, username FROM cron.job;
\ir ../../../migrations/20261119091700_cost_watchdog_trip_audit.sql
SELECT pg_temp.zz_assert(
  NOT EXISTS (
    SELECT jobid, jobname, database, command, active, schedule, username FROM cron.job
    EXCEPT
    SELECT jobid, jobname, database, command, active, schedule, username FROM zz_cron
  ),
  're-apply changes nothing');

UPDATE cron.job SET command = 'SELECT 1' WHERE jobid = 21;
DELETE FROM zz_cron;
INSERT INTO zz_cron SELECT jobid, jobname, database, command, active, schedule, username FROM cron.job;
SAVEPOINT different;
\set ON_ERROR_STOP off
\ir ../../../migrations/20261119091700_cost_watchdog_trip_audit.sql
\set different_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO different;
SELECT pg_temp.zz_assert(:'different_state' = 'P0001', 'different: must refuse, got ' || :'different_state');
SELECT pg_temp.zz_assert(
  NOT EXISTS (
    SELECT jobid, jobname, database, command, active, schedule, username FROM cron.job
    EXCEPT
    SELECT jobid, jobname, database, command, active, schedule, username FROM zz_cron
  ),
  'different: nothing changed');
UPDATE cron.job SET command = 'select public.director_cost_watchdog_tick(''job-profit-watchdog'')' WHERE jobid = 21;

INSERT INTO cron.job(jobid, jobname, command, active, schedule, database)
VALUES (26, 'job-matcher-watchdog', 'select public.director_cost_watchdog_tick(''job-matcher-watchdog'')', true, '* * * * *', current_database());
DELETE FROM zz_cron;
INSERT INTO zz_cron SELECT jobid, jobname, database, command, active, schedule, username FROM cron.job;
SAVEPOINT duplicate;
\set ON_ERROR_STOP off
\ir ../../../migrations/20261119091700_cost_watchdog_trip_audit.sql
\set duplicate_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO duplicate;
SELECT pg_temp.zz_assert(:'duplicate_state' = 'P0001', 'duplicate: must refuse, got ' || :'duplicate_state');
DELETE FROM cron.job WHERE jobid = 26;

-- Run the stored commands against a shadow activity view.
CREATE TEMP TABLE zz_activity(backend_type text, state text, pid integer, query_start timestamptz);
CREATE TEMP VIEW pg_stat_activity AS SELECT * FROM pg_temp.zz_activity;
DELETE FROM public.job_watchdog_trips;
-- The early intelligence migration is not part of this contract stack, so the
-- alerts table is supplied here when the database does not already have one.
CREATE TABLE IF NOT EXISTS public.ai_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type text NOT NULL,
  severity text NOT NULL,
  message text NOT NULL,
  recommended_action text,
  detail_json jsonb
);
DELETE FROM public.ai_alerts WHERE alert_type = 'cost_watchdog_trip';

-- Quiet: 3 slow queries. 119 connections. Nothing moves.
INSERT INTO zz_activity
SELECT 'client backend', 'active', -n, now() - interval '31 seconds' FROM generate_series(1, 3) n;
SELECT command FROM cron.job WHERE jobid IN (21, 22, 23) ORDER BY jobid \gexec
SELECT pg_temp.zz_assert(
  NOT EXISTS (SELECT 1 FROM public.cost_watchdog_trips)
  AND NOT EXISTS (SELECT 1 FROM public.job_watchdog_trips)
  AND (SELECT active FROM cron.job WHERE jobid = 24)
  AND NOT EXISTS (SELECT 1 FROM public.feature_flags
       WHERE flag_name IN ('job_profit_refresh_v1', 'reconcile_matcher_v1') AND NOT enabled)
  AND NOT EXISTS (SELECT 1 FROM public.ai_alerts WHERE alert_type = 'cost_watchdog_trip'),
  'quiet: 3 slow queries leave every switch on');
DELETE FROM zz_activity;
INSERT INTO zz_activity SELECT 'client backend', 'idle', -n, now() FROM generate_series(1, 119) n;
SELECT command FROM cron.job WHERE jobid IN (21, 23) ORDER BY jobid \gexec
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.cost_watchdog_trips), '119 connections: no trip');

-- Strain: a 4th slow query turns both switches off and pauses the page refresh.
DELETE FROM zz_activity;
INSERT INTO zz_activity
SELECT 'client backend', 'active', -n, now() - interval '31 seconds' FROM generate_series(1, 4) n;
SELECT command FROM cron.job WHERE jobid IN (21, 22, 23) ORDER BY jobid \gexec
SELECT pg_temp.zz_assert(
  NOT EXISTS (SELECT 1 FROM public.feature_flags
    WHERE flag_name IN ('job_profit_refresh_v1', 'reconcile_matcher_v1')
      AND (enabled OR description NOT LIKE '%[auto-off by watchdog %'))
  AND NOT (SELECT active FROM cron.job WHERE jobid = 24)
  AND (SELECT count(*) FROM public.cost_watchdog_trips) = 3
  AND NOT EXISTS (
    SELECT 1 FROM public.cost_watchdog_trips
    WHERE metric_name IS DISTINCT FROM 'over30s'
       OR metric_value IS DISTINCT FROM 4
       OR threshold IS DISTINCT FROM 4
       OR new_value
       OR previous_value IS NOT TRUE
       OR reason IS NULL
  )
  AND EXISTS (SELECT 1 FROM public.cost_watchdog_trips WHERE switch_key = 'job_profit_refresh_v1' AND watchdog_name = 'job-profit-watchdog')
  AND EXISTS (SELECT 1 FROM public.cost_watchdog_trips WHERE switch_key = 'reconcile_matcher_v1' AND watchdog_name = 'job-matcher-watchdog')
  AND EXISTS (SELECT 1 FROM public.cost_watchdog_trips WHERE switch_key = 'job-pages-refresh' AND watchdog_name = 'job-pages-watchdog')
  AND (SELECT trips FROM public.job_watchdog_trips WHERE guard = 'job-pages-watchdog') = 1
  AND (SELECT count(*) FROM public.ai_alerts WHERE alert_type = 'cost_watchdog_trip' AND severity = 'amber') = 3,
  'strain: off, tripped, alerted');

-- Already off or paused: no second trip.
SELECT command FROM cron.job WHERE jobid IN (21, 22, 23) ORDER BY jobid \gexec
SELECT pg_temp.zz_assert((SELECT count(*) FROM public.cost_watchdog_trips) = 3, 'already off: no new trip');

-- 120 connections, switches turned back on by the test (the watchdog does not).
UPDATE public.feature_flags SET enabled = true
 WHERE flag_name IN ('job_profit_refresh_v1', 'reconcile_matcher_v1');
UPDATE cron.job SET active = true WHERE jobid = 24;
DELETE FROM zz_activity;
INSERT INTO zz_activity SELECT 'client backend', 'idle', -n, now() FROM generate_series(1, 120) n;
SELECT command FROM cron.job WHERE jobid IN (21, 23) ORDER BY jobid \gexec
SELECT pg_temp.zz_assert(
  (SELECT count(*) FROM public.cost_watchdog_trips
    WHERE metric_name = 'conns' AND metric_value = 120 AND threshold = 120) = 2
  AND NOT EXISTS (SELECT 1 FROM public.feature_flags
       WHERE flag_name IN ('job_profit_refresh_v1', 'reconcile_matcher_v1') AND enabled),
  '120 connections: off, threshold 120');

-- A broken alert table cannot keep the switch on, and cannot drop the trip.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_profit_refresh_v1';
CREATE FUNCTION public.zztest_cost_watchdog_alert_block() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN RAISE EXCEPTION 'zztest alert blocked'; END $t$;
CREATE TRIGGER zztest_cost_watchdog_alert_block
  BEFORE INSERT ON public.ai_alerts
  FOR EACH ROW WHEN (NEW.alert_type = 'cost_watchdog_trip')
  EXECUTE FUNCTION public.zztest_cost_watchdog_alert_block();
SELECT command FROM cron.job WHERE jobid = 21 \gexec
SELECT pg_temp.zz_assert(
  NOT (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_profit_refresh_v1')
  AND (SELECT count(*) FROM public.cost_watchdog_trips WHERE switch_key = 'job_profit_refresh_v1') = 3
  AND (SELECT count(*) FROM public.ai_alerts WHERE alert_type = 'cost_watchdog_trip') = 5,
  'alert failure: switch off, trip kept, no new alert');
DROP TRIGGER zztest_cost_watchdog_alert_block ON public.ai_alerts;
DROP FUNCTION public.zztest_cost_watchdog_alert_block();

-- A broken trip table cannot keep the switch on either.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_profit_refresh_v1';
CREATE FUNCTION public.zztest_cost_watchdog_trip_block() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN RAISE EXCEPTION 'zztest trip blocked'; END $t$;
CREATE TRIGGER zztest_cost_watchdog_trip_block
  BEFORE INSERT ON public.cost_watchdog_trips
  FOR EACH ROW EXECUTE FUNCTION public.zztest_cost_watchdog_trip_block();
SELECT command FROM cron.job WHERE jobid = 21 \gexec
SELECT pg_temp.zz_assert(
  NOT (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_profit_refresh_v1')
  AND (SELECT count(*) FROM public.cost_watchdog_trips WHERE switch_key = 'job_profit_refresh_v1') = 3,
  'trip failure: switch still off');
DROP TRIGGER zztest_cost_watchdog_trip_block ON public.cost_watchdog_trips;
DROP FUNCTION public.zztest_cost_watchdog_trip_block();

-- Nothing turns a switch back on. The test had turned the page refresh back
-- on earlier; the watchdog must leave that paused state paused.
UPDATE cron.job SET active = false WHERE jobid = 24;
DELETE FROM zz_activity;
SELECT command FROM cron.job WHERE jobid IN (21, 22, 23) ORDER BY jobid \gexec
SELECT pg_temp.zz_assert(
  NOT (SELECT active FROM cron.job WHERE jobid = 24)
  AND NOT EXISTS (SELECT 1 FROM public.feature_flags
       WHERE flag_name IN ('job_profit_refresh_v1', 'reconcile_matcher_v1') AND enabled),
  'nothing turns back on');
DROP VIEW pg_stat_activity;

-- Rollback restores the pinned statements and drops the audit. Flags stay off.
\ir ../../../rollbacks/20261119091700_cost_watchdog_trip_audit_down.sql
SELECT pg_temp.zz_assert(
  md5((SELECT command FROM cron.job WHERE jobid = 21)) = '3e2257bc5622e26f37b36e44b1c48b90'
  AND md5((SELECT command FROM cron.job WHERE jobid = 23)) = 'b69012508de0a1d041a186b91817175e'
  AND md5((SELECT command FROM cron.job WHERE jobid = 22)) = '24fe57c8917e81268c823db6b98955fb'
  AND NOT (SELECT active FROM cron.job WHERE jobid = 22)
  AND (SELECT schedule FROM cron.job WHERE jobid = 21) = '* * * * *'
  AND to_regclass('public.cost_watchdog_trips') IS NULL
  AND to_regprocedure('public.director_cost_watchdog_tick(text)') IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.feature_flags
       WHERE flag_name IN ('job_profit_refresh_v1', 'reconcile_matcher_v1') AND enabled)
  AND NOT EXISTS (SELECT 1 FROM public.ai_alerts WHERE alert_type = 'cost_watchdog_trip'),
  'rollback restores the statements and drops the audit');
\ir ../../../rollbacks/20261119091700_cost_watchdog_trip_audit_down.sql
SELECT pg_temp.zz_assert(
  md5((SELECT command FROM cron.job WHERE jobid = 21)) = '3e2257bc5622e26f37b36e44b1c48b90',
  'rollback re-run');

CREATE TEMP TABLE zz_saved_23 AS SELECT command FROM cron.job WHERE jobid = 23;
UPDATE cron.job SET command = 'SELECT 1' WHERE jobid = 23;
DELETE FROM zz_cron;
INSERT INTO zz_cron SELECT jobid, jobname, database, command, active, schedule, username FROM cron.job;
SAVEPOINT rollback_different;
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261119091700_cost_watchdog_trip_audit_down.sql
\set rollback_different_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO rollback_different;
SELECT pg_temp.zz_assert(:'rollback_different_state' = 'P0001', 'rollback_different: must refuse, got ' || :'rollback_different_state');
SELECT pg_temp.zz_assert(
  (SELECT command FROM cron.job WHERE jobid = 23) = 'SELECT 1',
  'rollback different: nothing changed');
UPDATE cron.job SET command = (SELECT command FROM zz_saved_23) WHERE jobid = 23;

\ir ../../../migrations/20261119091700_cost_watchdog_trip_audit.sql
SELECT pg_temp.zz_assert(
  (SELECT command FROM cron.job WHERE jobid = 21) = 'select public.director_cost_watchdog_tick(''job-profit-watchdog'')'
  AND to_regclass('public.cost_watchdog_trips') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.feature_flags
       WHERE flag_name IN ('job_profit_refresh_v1', 'reconcile_matcher_v1') AND enabled),
  'round trip');

ROLLBACK;
\echo 'PASS: cost watchdog trips record an off switch, alert when they can, and never turn a switch on.'
