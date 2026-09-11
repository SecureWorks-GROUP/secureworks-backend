BEGIN;

-- pg_net is absent from the plain PostgreSQL runner. Stand in a recorder with
-- the production net.http_post signature (url, body, params, headers,
-- timeout_milliseconds) RETURNS bigint, so a post is observable. Rolled back.
CREATE SCHEMA net;
CREATE TABLE net.contract_posts (url text, body jsonb, headers jsonb);
CREATE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net.contract_posts (url, body, headers) VALUES (url, body, headers);
  SELECT 1::bigint;
$$;

DO $$
DECLARE
  cols text := 'id, job_number';
  vals text := quote_literal('80000000-0000-4000-8000-000000000001') || ', ' || quote_literal('SWMS-261399');
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'org_id') THEN
    cols := cols || ', org_id'; vals := vals || ', ' || quote_literal('00000000-0000-4000-8000-000000000001');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'type') THEN
    cols := cols || ', type'; vals := vals || ', ' || quote_literal('makesafe');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'status') THEN
    cols := cols || ', status'; vals := vals || ', ' || quote_literal('scheduled');
  END IF;
  EXECUTE format('INSERT INTO public.jobs (%s) VALUES (%s)', cols, vals);
END $$;

-- 1. The flag exists as one row, defaults on, and the helper reads it.
DO $$
DECLARE n integer; v boolean; d text;
BEGIN
  SELECT count(*), bool_and(drain_enabled) INTO n, v FROM public.ses_report_trigger_settings;
  IF n <> 1 OR v IS NOT TRUE THEN RAISE EXCEPTION 'contract: settings row missing or not enabled (rows=%, enabled=%)', n, v; END IF;
  SELECT column_default INTO d FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ses_report_trigger_settings' AND column_name = 'drain_enabled';
  IF d IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'contract: drain_enabled column default is %, expected true', d; END IF;
  IF public.ses_report_drain_enabled() IS NOT TRUE THEN RAISE EXCEPTION 'contract: ses_report_drain_enabled() is not true by default'; END IF;
END $$;

-- 2. The single-row guard refuses a second settings row.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.ses_report_trigger_settings (id, drain_enabled) VALUES (false, false);
    RAISE EXCEPTION 'contract: a second settings row was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 3. The incident state: make-safe email polling gate off, drain flag on, no
--    runnable row. The drain passes the gate and returns without posting.
DO $$
DECLARE n integer;
BEGIN
  IF public.makesafe_cron_enabled() THEN RAISE EXCEPTION 'contract: fixture make-safe gate must be false'; END IF;
  PERFORM public.trigger_ses_report_trigger_drain();
  SELECT count(*) INTO n FROM net.contract_posts;
  IF n <> 0 THEN RAISE EXCEPTION 'contract: drain posted with no runnable row (posts=%)', n; END IF;
END $$;

-- 4. Same gate state with a real pending run (the SWMS-261399 shape): the drain
--    no longer waits on the make-safe gate and posts that run to ops-api.
INSERT INTO public.ses_report_trigger_runs (id, dedupe_key, job_id, event_type, state)
VALUES ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001:cycle?:report:contract',
        '80000000-0000-4000-8000-000000000001', 'makesafe_report_submitted', 'pending');
DO $$
DECLARE n integer; p net.contract_posts;
BEGIN
  IF public.next_ses_report_trigger_run() IS DISTINCT FROM '81000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'contract: fixture run is not the next runnable row';
  END IF;
  PERFORM public.trigger_ses_report_trigger_drain();
  SELECT count(*) INTO n FROM net.contract_posts;
  IF n <> 1 THEN RAISE EXCEPTION 'contract: drain did not post the pending run past the make-safe gate (posts=%)', n; END IF;
  SELECT * INTO p FROM net.contract_posts LIMIT 1;
  IF p.url <> 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=run_ses_report_trigger'
     OR p.body <> jsonb_build_object('run_id', '81000000-0000-4000-8000-000000000001', 'actor', 'ses-report-trigger-drain')
     OR p.headers->>'Authorization' <> 'Bearer contract-fixture-key'
     OR p.headers->>'Content-Type' <> 'application/json' THEN
    RAISE EXCEPTION 'contract: drain post changed shape: %', row_to_json(p);
  END IF;
  DELETE FROM net.contract_posts;
END $$;

-- 5. Flag off: the drain returns early even with a runnable row.
UPDATE public.ses_report_trigger_settings SET drain_enabled = false, updated_by = 'contract', updated_at = now();
DO $$
DECLARE n integer;
BEGIN
  IF public.ses_report_drain_enabled() THEN RAISE EXCEPTION 'contract: helper still true after flag set false'; END IF;
  PERFORM public.trigger_ses_report_trigger_drain();
  SELECT count(*) INTO n FROM net.contract_posts;
  IF n <> 0 THEN RAISE EXCEPTION 'contract: drain posted with the flag off (posts=%)', n; END IF;
END $$;

-- 6. A missing settings row fails closed: helper false, no post.
DELETE FROM public.ses_report_trigger_settings;
DO $$
DECLARE n integer;
BEGIN
  IF public.ses_report_drain_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'contract: helper is not false with the settings row missing'; END IF;
  PERFORM public.trigger_ses_report_trigger_drain();
  SELECT count(*) INTO n FROM net.contract_posts;
  IF n <> 0 THEN RAISE EXCEPTION 'contract: drain posted with the settings row missing (posts=%)', n; END IF;
END $$;

-- 7. Without pg_cron the cron run reader returns an empty set, not an error.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.ses_report_drain_cron_runs(5);
  IF n <> 0 THEN RAISE EXCEPTION 'contract: cron run reader returned rows without a cron schema (rows=%)', n; END IF;
END $$;

-- 8. Server-owned switch: RLS on, browser roles hold no table or function privilege; service_role does.
DO $$
DECLARE r text; p text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ses_report_trigger_settings'::regclass) THEN
    RAISE EXCEPTION 'contract: row level security is not enabled on ses_report_trigger_settings';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.ses_report_trigger_settings', p) THEN
        RAISE EXCEPTION 'contract: % holds % on ses_report_trigger_settings', r, p;
      END IF;
    END LOOP;
    IF has_function_privilege(r, 'public.ses_report_drain_enabled()', 'EXECUTE')
       OR has_function_privilege(r, 'public.ses_report_drain_cron_runs(integer)', 'EXECUTE')
       OR has_function_privilege(r, 'public.trigger_ses_report_trigger_drain()', 'EXECUTE') THEN
      RAISE EXCEPTION 'contract: % can execute a drain flag function', r;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.ses_report_trigger_settings', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.ses_report_trigger_settings', 'UPDATE')
     OR NOT has_function_privilege('service_role', 'public.ses_report_drain_cron_runs(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: service_role cannot read or flip the drain flag';
  END IF;
END $$;

ROLLBACK;
