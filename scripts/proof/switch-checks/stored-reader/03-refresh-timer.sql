-- Stored reader, check 3: the refresh timer runs. Both jobs that
-- job_profit_refresh_install schedules are active and the refresh job
-- succeeded in the last 5 minutes (it runs every minute).
-- pg_cron row security can hide a job owned by another role: zero rows here
-- is not proof the job is absent. Run as the jobs' owner before reading a
-- FAIL as "not scheduled".
\set zz_check 'stored_reader.refresh_timer'
\ir ../session.sql
SELECT to_regclass('cron.job') IS NOT NULL AND to_regclass('cron.job_run_details') IS NOT NULL AS zz_cron
\gset
\if :zz_cron
WITH want(name) AS (VALUES ('job-profit-refresh-marked'), ('job-profit-refresh-daily')),
seen AS (
  SELECT w.name, j.jobid, j.active, j.schedule
  FROM want w LEFT JOIN cron.job j ON j.jobname = w.name
), last_run AS (
  SELECT s.name, r.status, r.end_time
  FROM seen s
  LEFT JOIN LATERAL (SELECT d.status, d.end_time FROM cron.job_run_details d
                     WHERE d.jobid = s.jobid ORDER BY d.runid DESC LIMIT 1) r ON true
)
SELECT :'zz_check' AS "check",
       CASE WHEN (SELECT count(*) FROM seen WHERE active IS TRUE) = 2
             AND EXISTS (SELECT 1 FROM last_run WHERE name = 'job-profit-refresh-marked'
                         AND status = 'succeeded' AND end_time > now() - interval '5 minutes')
            THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('jobs', (SELECT jsonb_agg(jsonb_build_object('name', s.name, 'found', s.jobid IS NOT NULL,
                                     'active', s.active, 'schedule', s.schedule,
                                     'last_status', l.status, 'last_end', l.end_time) ORDER BY s.name)
                                   FROM seen s JOIN last_run l USING (name)),
                          'note', 'pg_cron row security can hide another role''s job')::text AS evidence;
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result, '{"guard":"cron.job or cron.job_run_details not readable"}' AS evidence;
\endif
