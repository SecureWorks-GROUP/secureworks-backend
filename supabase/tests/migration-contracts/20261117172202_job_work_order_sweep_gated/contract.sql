\ir ../../../migrations/20261117172202_job_work_order_sweep_gated.sql
-- Stub transport only in this disposable contract session. It never calls a network.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TEMP TABLE sweep_gate_posts (url text);
CREATE TEMP TABLE sweep_gate_original_flags AS
  SELECT flag_name, enabled FROM public.feature_flags
  WHERE flag_name IN ('sweep_gate_v1', 'job_work_order_auto_issue_v1');
CREATE OR REPLACE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO pg_temp.sweep_gate_posts VALUES (url);
  RETURN 1;
END $$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'local-contract'::text $$;
INSERT INTO public.feature_flags(flag_name, enabled, description)
VALUES ('job_work_order_auto_issue_v1', true, 'Local contract')
ON CONFLICT (flag_name) DO UPDATE SET enabled = true;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'sweep_gate_v1';
SELECT pg_stat_force_next_flush();
SELECT public.trigger_job_work_order_auto_issue();
-- Simulate the good sweep's P0-06.3 confirmation. An unconfirmed post must retry.
SELECT public.sweep_gate_confirm(name, last_token) FROM public.sweep_gate_state
WHERE name = 'job-work-order-auto-issue';
CREATE TEMP TABLE sweep_gate_post_before AS SELECT last_posted_at FROM public.sweep_gate_state
WHERE name = 'job-work-order-auto-issue';
SELECT public.trigger_job_work_order_auto_issue();
DO $contract$ BEGIN
  IF (SELECT count(*) FROM pg_temp.sweep_gate_posts) <> 1 THEN
    RAISE EXCEPTION 'unchanged confirmed sweep posted twice';
  END IF;
  IF (SELECT last_posted_at FROM public.sweep_gate_state WHERE name = 'job-work-order-auto-issue')
     IS DISTINCT FROM (SELECT last_posted_at FROM pg_temp.sweep_gate_post_before) THEN
    RAISE EXCEPTION 'skipped sweep moved last_posted_at';
  END IF;
END $contract$;
-- The assignment fixture carries no job or person and is committed before the stats read.
INSERT INTO public.job_assignments(id) VALUES ('00000000-0000-4000-8000-000000002201');
SELECT pg_stat_force_next_flush();
SELECT pg_stat_clear_snapshot();
SELECT public.trigger_job_work_order_auto_issue();
DO $contract$ BEGIN
  IF (SELECT count(*) FROM pg_temp.sweep_gate_posts) <> 2 THEN
    RAISE EXCEPTION 'changed booking did not post';
  END IF;
  IF (SELECT last_posted_at FROM public.sweep_gate_state WHERE name = 'job-work-order-auto-issue')
     <= (SELECT last_posted_at FROM pg_temp.sweep_gate_post_before) THEN
    RAISE EXCEPTION 'changed booking did not move last_posted_at';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_temp.sweep_gate_posts
    WHERE url !~ 'action=auto_issue_job_work_orders&gate=job-work-order-auto-issue&gate_token=[a-f0-9]{32}$') THEN
    RAISE EXCEPTION 'timer did not carry the confirmation coordinates';
  END IF;
END $contract$;
DELETE FROM public.job_assignments WHERE id = '00000000-0000-4000-8000-000000002201';
DELETE FROM public.sweep_gate_state WHERE name = 'job-work-order-auto-issue';
UPDATE public.feature_flags f SET enabled = old.enabled FROM pg_temp.sweep_gate_original_flags old
WHERE f.flag_name = old.flag_name;
DELETE FROM public.feature_flags f WHERE f.flag_name = 'job_work_order_auto_issue_v1'
AND NOT EXISTS (SELECT 1 FROM pg_temp.sweep_gate_original_flags old WHERE old.flag_name = f.flag_name);
DROP FUNCTION net.http_post(text, jsonb, jsonb, integer);
