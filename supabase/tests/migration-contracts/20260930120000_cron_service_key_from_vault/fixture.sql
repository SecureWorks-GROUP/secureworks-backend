-- Test infrastructure shared by contract.sql, rollback-contract.sql and
-- preexisting-failure.sql, not a replacement for the production schema:
-- a pg_cron stand-in (cron.job plus cron.alter_job with pg_cron's owner rule),
-- a recording pg_net stand-in, the production job shapes, and a snapshot of
-- those jobs to compare against.
--
-- The key is whatever public.sw_service_key() returns when this runs; the
-- contract re-runs the jobs under a JWT-shaped key as well.

DO $$
BEGIN
  -- The legacy alias, in its post-20260930023008 shape, unless a registered
  -- case already provides it.
  IF to_regprocedure('public._sw_service_key()') IS NULL THEN
    CREATE FUNCTION public._sw_service_key() RETURNS text
      LANGUAGE plpgsql STABLE AS 'BEGIN RETURN public.sw_service_key(); END';
  END IF;
END $$;

CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(),
  username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true,
  jobname text
);

-- pg_cron refuses to alter a job owned by another user unless the caller is a
-- superuser.
CREATE FUNCTION cron.alter_job(
  job_id bigint,
  schedule text DEFAULT NULL,
  command text DEFAULT NULL,
  database text DEFAULT NULL,
  username text DEFAULT NULL,
  active boolean DEFAULT NULL
) RETURNS void AS $$
BEGIN
  UPDATE cron.job j
     SET schedule = coalesce(alter_job.schedule, j.schedule),
         command = coalesce(alter_job.command, j.command),
         database = coalesce(alter_job.database, j.database),
         username = coalesce(alter_job.username, j.username),
         active = coalesce(alter_job.active, j.active)
   WHERE j.jobid = alter_job.job_id
     AND (j.username = current_user
          OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job %', job_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE SCHEMA cron_contract;
CREATE TABLE cron_contract.sent (
  jobname text,
  phase text,
  url text NOT NULL,
  headers jsonb NOT NULL,
  body jsonb NOT NULL
);

CREATE SCHEMA IF NOT EXISTS net;
CREATE OR REPLACE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron_contract.sent (jobname, phase, url, headers, body)
  VALUES (current_setting('cron_contract.jobname', true),
          current_setting('cron_contract.phase', true), url, headers, body)
  RETURNING 1::bigint;
$$;

-- The eleven inline-literal jobs, in the shape 20260322000004 /
-- 20260322000011 wrote them, on the jittered schedules production runs.
INSERT INTO cron.job (jobname, schedule, command)
SELECT t.jobname, t.schedule, format(
  'SELECT net.http_post(url:=%L,headers:=%L::jsonb,body:=''{}''::jsonb);',
  'https://example.invalid/functions/v1/' || t.path,
  jsonb_build_object('Authorization', 'Bearer ' || public.sw_service_key(),
                     'Content-Type', 'application/json')::text
)
FROM (VALUES
  ('xero-token-refresh',    '9-59/20 * * * *',  'xero-sync?action=token_refresh'),
  ('xero-po-sync',          '8,38 * * * *',     'xero-sync?action=sync_purchase_orders'),
  ('xero-reports-sync',     '3 22 * * *',       'xero-sync?action=sync_reports'),
  ('xero-projects-sync',    '15 22 * * *',      'xero-sync?action=sync_projects'),
  ('xero-tracking-pl-sync', '30 22 * * *',      'xero-sync?action=sync_tracking_pl'),
  ('xero-bank-sync',        '45 22 * * *',      'xero-sync?action=sync_bank_balances'),
  ('xero-payables-sync',    '50 22 * * *',      'xero-sync?action=sync_aged_payables'),
  ('xero-suppliers-sync',   '55 22 * * *',      'xero-sync?action=sync_suppliers'),
  ('contact-matching',      '6 19 * * *',       'xero-sync?action=match_contacts'),
  ('system-health-check',   '21-59/30 * * * *', 'system-health'),
  ('xero-invoice-sync',     '4-59/15 * * * *',  'xero-sync?action=sync_invoices')
) AS t(jobname, schedule, path);

-- One inline job with extra whitespace, an extra header, a body and a timeout,
-- to prove the rewrite keeps everything else verbatim.
UPDATE cron.job
   SET command = format(
     'SELECT net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 10000)',
     'https://example.invalid/functions/v1/xero-sync?action=token_refresh',
     format('{ "Content-Type": "application/json", "Authorization": "Bearer %s", "x-client-info": "pg_cron" }',
       public.sw_service_key()),
     '{"source":"cron"}'
   )
 WHERE jobname = 'xero-token-refresh';

-- One inline job that pastes the key as a SQL string literal instead (the
-- shape the rollback writes back).
UPDATE cron.job
   SET command = format(
     'SELECT net.http_post(url:=%L,headers:=jsonb_build_object(''Authorization'',%L,''Content-Type'',''application/json''),body:=''{}''::jsonb);',
     'https://example.invalid/functions/v1/xero-sync?action=match_contacts',
     'Bearer ' || public.sw_service_key()
   )
 WHERE jobname = 'contact-matching';

-- Paused in production would stay paused.
UPDATE cron.job SET active = false WHERE jobname = 'xero-bank-sync';

-- The live-only job that calls the legacy helper.
INSERT INTO cron.job (jobname, schedule, command) VALUES (
  'weekly-ceo-financial-brief',
  '0 22 * * 0',
  $cmd$SELECT net.http_post(url:='https://example.invalid/functions/v1/daily-digest?action=ceo_financial_brief',headers:=jsonb_build_object('Authorization','Bearer '||_sw_service_key(),'Content-Type','application/json'),body:='{}'::jsonb);$cmd$
);

-- Unrelated jobs that must come through untouched.
INSERT INTO cron.job (jobname, schedule, command) VALUES
  ('process-outbound-queue', '* * * * *', 'SELECT public.process_outbound_queue()'),
  ('daily-digest-trigger', '0 23 * * *', 'SELECT public.trigger_daily_digest()');

CREATE TABLE cron_contract.before AS
SELECT jobid, jobname, schedule, active, username, database, command
  FROM cron.job;
CREATE TABLE cron_contract.fixture AS
SELECT public.sw_service_key() AS stack_key;

-- Runs every pg_net job, either as it was before the migration or as it is
-- now, recording each request under p_phase.
CREATE FUNCTION cron_contract.run_http_jobs(p_phase text, p_from_before boolean)
RETURNS void AS $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT jobname, command FROM cron_contract.before
     WHERE p_from_before AND command LIKE '%net.http_post%'
    UNION ALL
    SELECT jobname, command FROM cron.job
     WHERE NOT p_from_before AND command LIKE '%net.http_post%'
  LOOP
    PERFORM set_config('cron_contract.jobname', j.jobname, true);
    PERFORM set_config('cron_contract.phase', p_phase, true);
    EXECUTE j.command;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- The same request set under two phases, or the jobs that differ.
CREATE FUNCTION cron_contract.wire_diff(p_left text, p_right text) RETURNS text AS $$
  SELECT string_agg(coalesce(l.jobname, r.jobname), ', ' ORDER BY coalesce(l.jobname, r.jobname))
    FROM (SELECT * FROM cron_contract.sent WHERE phase = p_left) l
    FULL JOIN (SELECT * FROM cron_contract.sent WHERE phase = p_right) r USING (jobname)
   WHERE (l.url, l.headers, l.body) IS DISTINCT FROM (r.url, r.headers, r.body);
$$ LANGUAGE sql;
