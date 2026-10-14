-- Paid close-out (20261013150000): every switch ships off, the records keep one review
-- claim per job, and the closeout lane gates the sweep exactly as the automation switch
-- gates every other lane.

-- 1. The switches: one settings row, both off; the closeout lane column off.
DO $$
BEGIN
 IF (SELECT count(*) FROM public.job_closeout_settings) <> 1
  OR (SELECT get_review_move_enabled FROM public.job_closeout_settings WHERE id = 1)
  OR (SELECT review_sender_mode FROM public.job_closeout_settings WHERE id = 1) <> 'off'
 THEN RAISE EXCEPTION 'closeout contract: settings must ship off'; END IF;
 IF (SELECT closeout FROM public.automation_switches WHERE id = 1) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'closeout contract: the closeout lane must ship off'; END IF;
 IF public.automation_lane_enabled('closeout')
 THEN RAISE EXCEPTION 'closeout contract: closeout lane reads on'; END IF;
END $$;

-- 2. The sender mode is a closed list; the settings row is a singleton.
DO $$
BEGIN
 BEGIN
  UPDATE public.job_closeout_settings SET review_sender_mode = 'loud' WHERE id = 1;
  RAISE EXCEPTION 'closeout contract: an unknown sender mode was accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.job_closeout_settings (id) VALUES (2);
  RAISE EXCEPTION 'closeout contract: a second settings row was accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;

-- 3. The lane reader admits closeout, honours all_stop, and still refuses unknown lanes.
BEGIN;
UPDATE public.automation_switches SET closeout = true, all_stop = false WHERE id = 1;
DO $$
BEGIN
 IF NOT public.automation_lane_enabled('closeout') THEN RAISE EXCEPTION 'closeout contract: lane on reads off'; END IF;
 IF public.automation_lane_enabled('closeout_typo') THEN RAISE EXCEPTION 'closeout contract: unknown lane reads on'; END IF;
END $$;
UPDATE public.automation_switches SET all_stop = true WHERE id = 1;
DO $$
BEGIN
 IF public.automation_lane_enabled('closeout') THEN RAISE EXCEPTION 'closeout contract: all_stop did not stop closeout'; END IF;
END $$;
ROLLBACK;

-- 4. The lane list: every earlier row kept, plus job-closeout-sweep on closeout.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.automation_switch_cron_lanes()'::regprocedure) <> 'd0a346b823b56258bf67bc835f41f922'
  OR (SELECT array_agg(cron_jobname || ':' || lane ORDER BY cron_jobname COLLATE "C") FROM public.automation_switch_cron_lanes())
   IS DISTINCT FROM ARRAY['contact-matching:attribution','context-document-text:capture','ghl-call-transcript-fetch:capture',
    'ghl-history-schedule:capture','ghl-message-reconcile:capture','job-closeout-sweep:closeout','monitor-inbox-poll:capture',
    'monitor-inbox-sweep:capture','outlook-mail-deep-history:capture','outlook-mail-poll:capture','xero-history-daily:capture']
 THEN RAISE EXCEPTION 'closeout contract: lane list %', (SELECT array_agg(to_jsonb(l)) FROM public.automation_switch_cron_lanes() l); END IF;
END $$;

-- 5. One review claim per job, and only the known claim states.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000c105', '00000000-0000-0000-0000-000000000001', 'get_review', 'fencing', 'SWF-C105');
INSERT INTO public.job_review_claims (job_id, status, trigger) VALUES ('00000000-0000-0000-0000-00000000c105', 'claimed', 'contract');
DO $$
BEGIN
 BEGIN
  INSERT INTO public.job_review_claims (job_id, status, trigger) VALUES ('00000000-0000-0000-0000-00000000c105', 'claimed', 'again');
  RAISE EXCEPTION 'closeout contract: a second claim for the same job was accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  UPDATE public.job_review_claims SET status = 'resent' WHERE job_id = '00000000-0000-0000-0000-00000000c105';
  RAISE EXCEPTION 'closeout contract: an unknown claim state was accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.job_closeout_state (job_id, outcome) VALUES ('00000000-0000-0000-0000-00000000c105', 'mostly_paid');
  RAISE EXCEPTION 'closeout contract: an unknown paid outcome was accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
ROLLBACK;

-- 6. Access: service role only.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.job_closeout_settings','public.job_closeout_state','public.job_review_claims'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN RAISE EXCEPTION 'closeout contract: % RLS off', t; END IF;
  IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT')
   OR has_table_privilege('anon', t, 'INSERT') OR has_table_privilege('authenticated', t, 'UPDATE')
   OR NOT has_table_privilege('service_role', t, 'SELECT') OR NOT has_table_privilege('service_role', t, 'INSERT')
  THEN RAISE EXCEPTION 'closeout contract: % access', t; END IF;
 END LOOP;
 IF has_function_privilege('anon', 'public.trigger_job_closeout_sweep()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.trigger_job_closeout_sweep()', 'EXECUTE')
  OR NOT has_function_privilege('service_role', 'public.trigger_job_closeout_sweep()', 'EXECUTE')
 THEN RAISE EXCEPTION 'closeout contract: trigger_job_closeout_sweep execute'; END IF;
END $$;

-- 7. A re-apply changes nothing and keeps the operator's settings; on a pg_cron
-- stand-in the job is scheduled once, already gated, and the switch's wrap sees it so.
BEGIN;
UPDATE public.job_closeout_settings SET get_review_move_enabled = true, review_sender_mode = 'dry_run' WHERE id = 1;
UPDATE public.automation_switches SET closeout = true WHERE id = 1;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, active boolean NOT NULL DEFAULT true, jobname text);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid
$$;
\ir ../../../migrations/20261013150000_job_closeout_review_archive.sql
\ir ../../../migrations/20261013150000_job_closeout_review_archive.sql
DO $$
DECLARE w record;
BEGIN
 IF NOT (SELECT get_review_move_enabled FROM public.job_closeout_settings WHERE id = 1)
  OR (SELECT review_sender_mode FROM public.job_closeout_settings WHERE id = 1) <> 'dry_run'
 THEN RAISE EXCEPTION 'closeout contract: a re-apply changed the operator settings'; END IF;
 IF NOT (SELECT closeout FROM public.automation_switches WHERE id = 1) THEN RAISE EXCEPTION 'closeout contract: a re-apply turned the lane off'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.automation_switch_cron_lanes()'::regprocedure) <> 'd0a346b823b56258bf67bc835f41f922'
 THEN RAISE EXCEPTION 'closeout contract: a re-apply changed the lane list'; END IF;
 IF (SELECT count(*) FROM cron.job WHERE jobname = 'job-closeout-sweep') <> 1 THEN RAISE EXCEPTION 'closeout contract: scheduled more than once'; END IF;
 IF (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'job-closeout-sweep')
  <> '17,47 * * * * SELECT public.trigger_job_closeout_sweep() WHERE public.automation_lane_enabled(''closeout'')'
 THEN RAISE EXCEPTION 'closeout contract: job %', (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j); END IF;
 SELECT * INTO w FROM public.automation_switch_wrap_cron_jobs() x WHERE x.cron_jobname = 'job-closeout-sweep';
 IF w.outcome <> 'already_wrapped' THEN RAISE EXCEPTION 'closeout contract: wrap %', row_to_json(w); END IF;
END $$;
ROLLBACK;
