-- Test infrastructure shared by contract.sql, rollback-contract.sql and
-- preexisting-failure.sql, not a replacement for the production schema:
-- a pg_cron stand-in (cron.job, cron.schedule and cron.unschedule with
-- pg_cron's owner rule), the production job shapes, and a snapshot of the jobs
-- the migration must leave alone.

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

CREATE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command)
  VALUES (job_name, schedule, command)
  RETURNING jobid;
$$;

-- pg_cron refuses to unschedule a job owned by another user unless the caller
-- is a superuser.
CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean AS $$
BEGIN
  DELETE FROM cron.job j
   WHERE j.jobid = unschedule.job_id
     AND (j.username = current_user
          OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job %', job_id;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- The production shape from 20260406000001_debt_automation.sql, a copy of the
-- same caller under another name, a direct post to handle_payment_event, and
-- three jobs the ruling does not touch (stale-followup included: it also sends
-- the stale-quote and house-plans follow-ups).
INSERT INTO cron.job (jobname, schedule, command) VALUES
  ('xero-invoice-sync', '*/15 * * * *',
   $c$SELECT net.http_post(url:='https://example.invalid/functions/v1/xero-sync?action=invoices',headers:=jsonb_build_object('Authorization','Bearer '||public.sw_service_key()),body:='{}'::jsonb)$c$),
  ('process-payment-events', '*/5 * * * *', 'SELECT fn_process_payment_events()'),
  ('stale-followup', '0 1 * * *',
   $c$SELECT net.http_post(url:='https://example.invalid/functions/v1/daily-digest?action=stale_followup',headers:=jsonb_build_object('Authorization','Bearer '||public.sw_service_key()),body:='{}'::jsonb)$c$),
  ('payment-events-copy', '*/10 * * * *', 'select public.FN_PROCESS_PAYMENT_EVENTS()'),
  ('daily-digest', '30 22 * * *',
   $c$SELECT net.http_post(url:='https://example.invalid/functions/v1/daily-digest',headers:=jsonb_build_object('Authorization','Bearer '||public.sw_service_key()),body:='{}'::jsonb)$c$),
  ('payment-event-direct', '0 * * * *',
   $c$SELECT net.http_post(url:='https://example.invalid/functions/v1/ops-api?action=handle_payment_event',headers:='{}'::jsonb,body:='{}'::jsonb)$c$);

CREATE SCHEMA cron_contract;
CREATE TABLE cron_contract.untouched AS
  SELECT * FROM cron.job
   WHERE jobname IN ('xero-invoice-sync', 'stale-followup', 'daily-digest');
