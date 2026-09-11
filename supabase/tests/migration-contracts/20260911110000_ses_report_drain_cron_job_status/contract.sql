BEGIN;

-- 1. Without pg_cron or pg_net (this runner, a partial restore) every reader
--    returns an empty answer instead of failing.
DO $$
DECLARE n integer;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL OR to_regclass('net._http_response') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: runner already has cron.job or net._http_response before the stand-ins';
  END IF;
  SELECT count(*) INTO n FROM public.ses_report_drain_cron_job();
  IF n <> 0 THEN RAISE EXCEPTION 'contract: cron job reader returned rows without a cron schema (rows=%)', n; END IF;
  IF public.ses_report_drain_cron_run_count() IS NOT NULL THEN
    RAISE EXCEPTION 'contract: cron run count is not null without a cron schema';
  END IF;
  SELECT count(*) INTO n FROM public.ses_report_drain_http_responses(5);
  IF n <> 0 THEN RAISE EXCEPTION 'contract: http response reader returned rows without a net schema (rows=%)', n; END IF;
  SELECT count(*) INTO n FROM public.ses_report_cron_scheduler_pulse(30);
  IF n <> 0 THEN RAISE EXCEPTION 'contract: scheduler pulse returned rows without a cron schema (rows=%)', n; END IF;
END $$;

-- 2. Server-only readers: SECURITY DEFINER with a fixed search_path, no browser
--    role can execute them, service_role and postgres can. The settings table
--    comment says disable with UPDATE and never DELETE.
DO $$
DECLARE r text; f text; c text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.ses_report_drain_cron_job()', 'public.ses_report_drain_cron_run_count()', 'public.ses_report_drain_http_responses(integer)', 'public.ses_report_cron_scheduler_pulse(integer)'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN RAISE EXCEPTION 'contract: % can execute %', r, f; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') OR NOT has_function_privilege('postgres', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract: service_role or postgres cannot execute %', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure AND prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION 'contract: % is not SECURITY DEFINER with search_path public, pg_temp', f;
    END IF;
  END LOOP;
  c := obj_description('public.ses_report_trigger_settings'::regclass, 'pg_class');
  IF c IS NULL OR position('Disable with UPDATE' IN c) = 0 OR position('Never DELETE' IN c) = 0 OR position('re-seeds it as enabled' IN c) = 0 THEN
    RAISE EXCEPTION 'contract: settings table comment does not say UPDATE, never DELETE: %', c;
  END IF;
END $$;

-- pg_cron stand-in with pg_cron 1.6 column names and types (cron.job from
-- 1.0.0 plus active and jobname text; job_run_details from 1.3.1).
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (
  jobid bigint PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(),
  username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true,
  jobname text,
  CONSTRAINT jobname_username_uniq UNIQUE (jobname, username)
);
CREATE TABLE cron.job_run_details (
  jobid bigint,
  runid bigint PRIMARY KEY,
  job_pid integer,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);

-- 41: the drain, owned by postgres, inactive, with a command over 120 chars.
-- 42: another job. 43: a second ses-report-trigger-drain under another role.
INSERT INTO cron.job (jobid, schedule, command, username, active, jobname) VALUES
  (41, '* * * * *', 'SELECT public.trigger_ses_report_trigger_drain(); ' || repeat('-- padding ', 20), 'postgres', false, 'ses-report-trigger-drain'),
  (42, '*/5 * * * *', 'SELECT public.poll_makesafe_email()', 'postgres', true, 'makesafe-email-poll'),
  (43, '* * * * *', 'SELECT public.trigger_ses_report_trigger_drain()', 'contract_other_role', true, 'ses-report-trigger-drain');

-- 25 drain runs a minute apart, newest 2026-09-11T00:07:00Z (the live reading);
-- 2 older runs of job 43; 3 newer runs of the other job that must not appear.
INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
SELECT 41, g, 1000 + g, current_database(), 'postgres', 'SELECT public.trigger_ses_report_trigger_drain()', 'succeeded', 'drain run ' || g,
       timestamptz '2026-09-10T23:43:00Z' + (g - 1) * interval '1 minute',
       timestamptz '2026-09-10T23:43:00Z' + (g - 1) * interval '1 minute' + interval '50 milliseconds'
  FROM generate_series(1, 25) g;
INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
SELECT 43, 100 + g, 2000 + g, current_database(), 'contract_other_role', 'SELECT public.trigger_ses_report_trigger_drain()', 'succeeded', 'drain run twin ' || g,
       timestamptz '2026-09-10T20:00:00Z' + g * interval '1 minute', NULL
  FROM generate_series(1, 2) g;
INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
SELECT 42, 200 + g, 3000 + g, current_database(), 'postgres', 'SELECT public.poll_makesafe_email()', 'succeeded', 'other job ' || g,
       timestamptz '2026-09-11T02:00:00Z' + g * interval '1 minute', NULL
  FROM generate_series(1, 3) g;

-- 3. ses_report_drain_cron_runs with pg_cron present: jobname filter, newest
--    first, p_limit clamped to 20 and 1; NULL falls back to the default of 5.
DO $$
DECLARE n integer; other integer; newest timestamptz; oldest timestamptz; ordered boolean; first_start timestamptz;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE return_message LIKE 'other job%'), max(start_time), min(start_time)
    INTO n, other, newest, oldest FROM public.ses_report_drain_cron_runs(999);
  IF n <> 20 THEN RAISE EXCEPTION 'contract: cron run reader did not clamp 999 to 20 (rows=%)', n; END IF;
  IF other <> 0 THEN RAISE EXCEPTION 'contract: cron run reader returned another job''s runs (rows=%)', other; END IF;
  IF newest <> timestamptz '2026-09-11T00:07:00Z' OR oldest <> timestamptz '2026-09-10T23:48:00Z' THEN
    RAISE EXCEPTION 'contract: cron run reader is not the newest 20 drain runs (newest=%, oldest=%)', newest, oldest;
  END IF;
  SELECT bool_and(prev_start IS NULL OR start_time < prev_start) INTO ordered FROM (
    SELECT r.start_time, lag(r.start_time) OVER (ORDER BY r.ord) AS prev_start
      FROM public.ses_report_drain_cron_runs(999) WITH ORDINALITY AS r(status, return_message, start_time, end_time, ord)
  ) s;
  IF ordered IS NOT TRUE THEN RAISE EXCEPTION 'contract: cron run reader is not newest first'; END IF;
  SELECT count(*), max(start_time) INTO n, first_start FROM public.ses_report_drain_cron_runs(0);
  IF n <> 1 OR first_start <> timestamptz '2026-09-11T00:07:00Z' THEN
    RAISE EXCEPTION 'contract: cron run reader did not clamp 0 to the single newest run (rows=%, start=%)', n, first_start;
  END IF;
  SELECT count(*) INTO n FROM public.ses_report_drain_cron_runs(NULL);
  IF n <> 5 THEN RAISE EXCEPTION 'contract: cron run reader did not treat a null limit as 5 (rows=%)', n; END IF;
END $$;

-- 4. ses_report_drain_cron_job: jobname filter, jobid order, an inactive job
--    reported as active false, owning username, a 120-character command preview.
DO $$
DECLARE n integer; r record;
BEGIN
  SELECT count(*) INTO n FROM public.ses_report_drain_cron_job();
  IF n <> 2 THEN RAISE EXCEPTION 'contract: cron job reader did not filter on jobname (rows=%)', n; END IF;
  SELECT * INTO r FROM public.ses_report_drain_cron_job() LIMIT 1;
  IF r.jobid <> 41 OR r.jobname <> 'ses-report-trigger-drain' OR r.schedule <> '* * * * *'
     OR r.active IS DISTINCT FROM false OR r.username <> 'postgres' THEN
    RAISE EXCEPTION 'contract: inactive drain job not reported as active false: %', row_to_json(r);
  END IF;
  IF length(r.command_preview) <> 120 OR r.command_preview <> left((SELECT command FROM cron.job WHERE jobid = 41), 120) THEN
    RAISE EXCEPTION 'contract: command preview is not the first 120 characters: %', r.command_preview;
  END IF;
  SELECT * INTO r FROM public.ses_report_drain_cron_job() OFFSET 1 LIMIT 1;
  IF r.jobid <> 43 OR r.active IS DISTINCT FROM true OR r.username <> 'contract_other_role' THEN
    RAISE EXCEPTION 'contract: second drain job under another role not reported: %', row_to_json(r);
  END IF;
END $$;

-- 5. ses_report_drain_cron_run_count: every visible run for the drain jobname,
--    across both jobids and usernames, and not the other job's runs.
DO $$
DECLARE v bigint;
BEGIN
  v := public.ses_report_drain_cron_run_count();
  IF v IS DISTINCT FROM 27 THEN RAISE EXCEPTION 'contract: cron run count is not every visible drain run (count=%)', v; END IF;
END $$;

-- 5b. ses_report_cron_scheduler_pulse: every visible job, not only the drain,
--     each with its newest run; a job that has never run still appears (LEFT
--     JOIN) and sorts last; newest run first; p_limit clamped to 50 and 1.
--     45 never ran. 60 fillers so the 50 clamp is observable.
INSERT INTO cron.job (jobid, schedule, command, username, active, jobname)
VALUES (45, '0 3 * * *', 'SELECT public.contract_never_ran()', 'postgres', true, 'contract-never-ran');
INSERT INTO cron.job (jobid, schedule, command, username, active, jobname)
SELECT 100 + g, '* * * * *', 'SELECT 1', 'postgres', true, 'contract-filler-' || g FROM generate_series(1, 60) g;

DO $$
DECLARE n integer; r record; ordered boolean;
BEGIN
  SELECT count(*) INTO n FROM public.ses_report_cron_scheduler_pulse(999);
  IF n <> 50 THEN RAISE EXCEPTION 'contract: scheduler pulse did not clamp 999 to 50 (rows=%)', n; END IF;
  SELECT count(*) INTO n FROM public.ses_report_cron_scheduler_pulse(NULL);
  IF n <> 30 THEN RAISE EXCEPTION 'contract: scheduler pulse did not treat a null limit as 30 (rows=%)', n; END IF;

  -- Newest run first, across every job, and a never-run job still listed.
  SELECT bool_and(prev IS NULL OR last_start_time IS NULL OR last_start_time <= prev) INTO ordered FROM (
    SELECT p.last_start_time, lag(p.last_start_time) OVER (ORDER BY p.ord) AS prev
      FROM public.ses_report_cron_scheduler_pulse(50) WITH ORDINALITY
             AS p(jobid, jobname, schedule, active, username, last_start_time, last_status, ord)
  ) s;
  IF ordered IS NOT TRUE THEN RAISE EXCEPTION 'contract: scheduler pulse is not newest run first'; END IF;

  -- The other job ran most recently, so it heads the pulse even though this
  -- reader is named for the drain: that is how a dead scheduler is told apart
  -- from one dead job.
  SELECT * INTO r FROM public.ses_report_cron_scheduler_pulse(50) LIMIT 1;
  IF r.jobid <> 42 OR r.jobname <> 'makesafe-email-poll' OR r.last_start_time <> timestamptz '2026-09-11T02:03:00Z'
     OR r.last_status <> 'succeeded' THEN
    RAISE EXCEPTION 'contract: newest-run job does not head the scheduler pulse: %', row_to_json(r);
  END IF;
  SELECT count(*) INTO n FROM public.ses_report_cron_scheduler_pulse(0);
  IF n <> 1 THEN RAISE EXCEPTION 'contract: scheduler pulse did not clamp 0 to 1 (rows=%)', n; END IF;

  -- The inactive drain is reported with active false and only its own newest run.
  SELECT * INTO r FROM public.ses_report_cron_scheduler_pulse(50) WHERE jobid = 41;
  IF r.active IS DISTINCT FROM false OR r.schedule <> '* * * * *' OR r.username <> 'postgres'
     OR r.last_start_time <> timestamptz '2026-09-11T00:07:00Z' OR r.last_status <> 'succeeded' THEN
    RAISE EXCEPTION 'contract: inactive drain job wrong in scheduler pulse: %', row_to_json(r);
  END IF;
  SELECT * INTO r FROM public.ses_report_cron_scheduler_pulse(50) WHERE jobid = 43;
  IF r.last_start_time <> timestamptz '2026-09-10T20:02:00Z' THEN
    RAISE EXCEPTION 'contract: drain twin newest run wrong in scheduler pulse: %', row_to_json(r);
  END IF;

  -- LEFT JOIN: a job with no runs is listed with a null run, and sorts last.
  SELECT * INTO r FROM public.ses_report_cron_scheduler_pulse(50) WHERE jobid = 45;
  IF r.jobname <> 'contract-never-ran' OR r.last_start_time IS NOT NULL OR r.last_status IS NOT NULL THEN
    RAISE EXCEPTION 'contract: never-run job dropped or invented a run: %', row_to_json(r);
  END IF;
  SELECT count(*) INTO n FROM public.ses_report_cron_scheduler_pulse(3) WHERE last_start_time IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'contract: never-run jobs did not sort last (rows=%)', n; END IF;
END $$;

-- pg_net stand-in with pg_net 0.20 column names and types.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (
  id bigint,
  status_code integer,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz NOT NULL DEFAULT now()
);
INSERT INTO net._http_response (id, status_code, content_type, headers, content, timed_out, error_msg, created)
SELECT g, 200, 'application/json', '{}'::jsonb, '{"ok":true,"n":' || g || '}' || repeat('x', 300), false, NULL,
       timestamptz '2026-09-11T00:00:00Z' + g * interval '1 minute'
  FROM generate_series(1, 25) g;
INSERT INTO net._http_response (id, status_code, content_type, headers, content, timed_out, error_msg, created)
VALUES (26, NULL, NULL, NULL, NULL, true, 'Timeout of 5000 ms reached', timestamptz '2026-09-11T00:30:00Z');

-- 6. ses_report_drain_http_responses: newest first, content cut to 200
--    characters, a timeout row carried as-is, p_limit clamped like the runs.
DO $$
DECLARE n integer; r record; ordered boolean;
BEGIN
  SELECT count(*) INTO n FROM public.ses_report_drain_http_responses(999);
  IF n <> 20 THEN RAISE EXCEPTION 'contract: http response reader did not clamp 999 to 20 (rows=%)', n; END IF;
  SELECT bool_and(prev_created IS NULL OR created < prev_created) INTO ordered FROM (
    SELECT h.created, lag(h.created) OVER (ORDER BY h.ord) AS prev_created
      FROM public.ses_report_drain_http_responses(999) WITH ORDINALITY AS h(id, status_code, content_preview, created, timed_out, error_msg, ord)
  ) s;
  IF ordered IS NOT TRUE THEN RAISE EXCEPTION 'contract: http response reader is not newest first'; END IF;
  SELECT * INTO r FROM public.ses_report_drain_http_responses(0);
  IF r.id <> 26 OR r.timed_out IS DISTINCT FROM true OR r.error_msg <> 'Timeout of 5000 ms reached'
     OR r.status_code IS NOT NULL OR r.content_preview IS NOT NULL THEN
    RAISE EXCEPTION 'contract: newest http response (a timeout) not reported as-is: %', row_to_json(r);
  END IF;
  SELECT count(*) INTO n FROM public.ses_report_drain_http_responses(0);
  IF n <> 1 THEN RAISE EXCEPTION 'contract: http response reader did not clamp 0 to 1 (rows=%)', n; END IF;
  SELECT count(*) INTO n FROM public.ses_report_drain_http_responses(NULL);
  IF n <> 5 THEN RAISE EXCEPTION 'contract: http response reader did not treat a null limit as 5 (rows=%)', n; END IF;
  SELECT * INTO r FROM public.ses_report_drain_http_responses(2) OFFSET 1;
  IF r.id <> 25 OR r.status_code <> 200 OR length(r.content_preview) <> 200 OR r.timed_out IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'contract: http response content not cut to 200 characters: %', row_to_json(r);
  END IF;
END $$;

-- 7. pg_cron row security (USING username = current_user, as pg_cron ships it)
--    applied to a non-superuser definer: jobs and runs owned by other roles are
--    invisible, so the readers report nothing rather than failing. This is the
--    "re-created under another role" shape.
CREATE ROLE contract_drain_definer NOLOGIN;
GRANT USAGE ON SCHEMA cron TO contract_drain_definer;
GRANT SELECT ON cron.job, cron.job_run_details TO contract_drain_definer;
ALTER TABLE cron.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron.job_run_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY cron_job_policy ON cron.job USING (username OPERATOR(pg_catalog.=) current_user);
CREATE POLICY cron_job_run_details_policy ON cron.job_run_details USING (username OPERATOR(pg_catalog.=) current_user);
ALTER FUNCTION public.ses_report_drain_cron_job() OWNER TO contract_drain_definer;
ALTER FUNCTION public.ses_report_drain_cron_run_count() OWNER TO contract_drain_definer;
ALTER FUNCTION public.ses_report_drain_cron_runs(integer) OWNER TO contract_drain_definer;
ALTER FUNCTION public.ses_report_cron_scheduler_pulse(integer) OWNER TO contract_drain_definer;
DO $$
DECLARE n integer; v bigint;
BEGIN
  SELECT count(*) INTO n FROM public.ses_report_drain_cron_job();
  IF n <> 0 THEN RAISE EXCEPTION 'contract: definer saw drain jobs owned by other roles (rows=%)', n; END IF;
  v := public.ses_report_drain_cron_run_count();
  IF v IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'contract: definer counted runs owned by other roles (count=%)', v; END IF;
  SELECT count(*) INTO n FROM public.ses_report_drain_cron_runs(20);
  IF n <> 0 THEN RAISE EXCEPTION 'contract: definer read runs owned by other roles (rows=%)', n; END IF;
  SELECT count(*) INTO n FROM public.ses_report_cron_scheduler_pulse(50);
  IF n <> 0 THEN RAISE EXCEPTION 'contract: definer saw jobs owned by other roles in the pulse (rows=%)', n; END IF;
END $$;
INSERT INTO cron.job (jobid, schedule, command, username, active, jobname)
VALUES (44, '* * * * *', 'SELECT public.trigger_ses_report_trigger_drain()', 'contract_drain_definer', true, 'ses-report-trigger-drain');
INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
VALUES (44, 400, 4000, current_database(), 'contract_drain_definer', 'SELECT public.trigger_ses_report_trigger_drain()', 'succeeded', 'own run',
        timestamptz '2026-09-11T02:22:00Z', timestamptz '2026-09-11T02:22:00.05Z');
DO $$
DECLARE n integer; v bigint; r record;
BEGIN
  SELECT count(*) INTO n FROM public.ses_report_drain_cron_job();
  SELECT * INTO r FROM public.ses_report_drain_cron_job();
  IF n <> 1 OR r.jobid <> 44 OR r.username <> 'contract_drain_definer' THEN
    RAISE EXCEPTION 'contract: definer did not see its own drain job (rows=%, row=%)', n, row_to_json(r);
  END IF;
  v := public.ses_report_drain_cron_run_count();
  IF v IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'contract: definer run count is not its own single run (count=%)', v; END IF;
  SELECT count(*) INTO n FROM public.ses_report_cron_scheduler_pulse(50);
  SELECT * INTO r FROM public.ses_report_cron_scheduler_pulse(50);
  IF n <> 1 OR r.jobid <> 44 OR r.username <> 'contract_drain_definer'
     OR r.last_start_time <> timestamptz '2026-09-11T02:22:00Z' OR r.last_status <> 'succeeded' THEN
    RAISE EXCEPTION 'contract: scheduler pulse is not the definer''s own single job (rows=%, row=%)', n, row_to_json(r);
  END IF;
END $$;

-- 8. A definer without SELECT on job_run_details gets NULL from the count
--    helper (insufficient_privilege caught), not an error.
REVOKE SELECT ON cron.job_run_details FROM contract_drain_definer;
DO $$
BEGIN
  IF public.ses_report_drain_cron_run_count() IS NOT NULL THEN
    RAISE EXCEPTION 'contract: cron run count did not return null without privilege on job_run_details';
  END IF;
END $$;

ROLLBACK;

-- 9. The stand-ins, the role and the ownership changes rolled back.
DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL OR to_regclass('net._http_response') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contract_drain_definer') THEN
    RAISE EXCEPTION 'contract: pg_cron or pg_net stand-ins leaked past the rollback';
  END IF;
END $$;
