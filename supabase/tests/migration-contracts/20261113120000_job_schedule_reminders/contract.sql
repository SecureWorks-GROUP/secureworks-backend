-- Contract for 20261113120000_job_schedule_reminders.sql. Every fixture write is inside a
-- transaction that rolls back.

-- 1. The switch ships off and is a closed list (off, live); the other switches are untouched.
DO $$
BEGIN
  IF (SELECT schedule_reminder_mode FROM public.job_closeout_settings WHERE id = 1) <> 'off' THEN
    RAISE EXCEPTION 'schedule reminders contract: the switch must ship off';
  END IF;
  IF (SELECT deposit_advance_mode FROM public.job_closeout_settings WHERE id = 1) <> 'off' THEN
    RAISE EXCEPTION 'schedule reminders contract: the deposit switch changed';
  END IF;
  BEGIN
    UPDATE public.job_closeout_settings SET schedule_reminder_mode = 'dry_run' WHERE id = 1;
    RAISE EXCEPTION 'schedule reminders contract: an unknown mode was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 2. The record and the run log: row-level security, one service-role policy, no
-- browser role can read them.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_schedule_reminders', 'job_schedule_reminder_runs'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'schedule reminders contract: % requires row-level security', t;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t) <> 1
       OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                   AND NOT (roles = ARRAY['service_role']::name[])) THEN
      RAISE EXCEPTION 'schedule reminders contract: % must carry exactly one service-role policy', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'schedule reminders contract: anon or authenticated can read %', t;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.trigger_job_schedule_reminders()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_job_schedule_reminders()', 'EXECUTE') THEN
    RAISE EXCEPTION 'schedule reminders contract: a browser role can run the cron caller';
  END IF;
END $$;

-- 3. Once a day per job and recipient: the claim insert that loses the race inserts nothing.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-E001');
INSERT INTO public.job_schedule_reminders (job_id, recipient_key, ghl_contact_id, send_on, kind, work_day)
VALUES ('00000000-0000-0000-0000-00000000e001', 'c-1', 'c-1', '2026-11-13', 'weekly', '2026-11-27');
DO $$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO public.job_schedule_reminders (job_id, recipient_key, send_on, kind, work_day)
  VALUES ('00000000-0000-0000-0000-00000000e001', 'c-1', '2026-11-13', 'weekly', '2026-11-27')
  ON CONFLICT (job_id, recipient_key, send_on) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'schedule reminders contract: a second claim for the same day was taken';
  END IF;
  IF (SELECT status FROM public.job_schedule_reminders WHERE recipient_key = 'c-1') <> 'claimed' THEN
    RAISE EXCEPTION 'schedule reminders contract: a claim must start as claimed';
  END IF;
  -- The next day is a new row; another recipient the same day is too.
  INSERT INTO public.job_schedule_reminders (job_id, recipient_key, send_on, kind, work_day)
  VALUES ('00000000-0000-0000-0000-00000000e001', 'c-1', '2026-11-20', 'weekly', '2026-11-27'),
         ('00000000-0000-0000-0000-00000000e001', 'c-2', '2026-11-13', 'weekly', '2026-11-27');
  UPDATE public.job_schedule_reminders SET status = 'skipped_similar_prior' WHERE recipient_key = 'c-2';
  UPDATE public.job_schedule_reminders SET status = 'sent' WHERE recipient_key = 'c-1' AND send_on = '2026-11-13';
  BEGIN
    UPDATE public.job_schedule_reminders SET status = 'maybe' WHERE recipient_key = 'c-2';
    RAISE EXCEPTION 'schedule reminders contract: an unknown status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.job_schedule_reminders (job_id, recipient_key, send_on, kind, work_day)
    VALUES ('00000000-0000-0000-0000-00000000e001', 'c-3', '2026-11-13', 'three_days', '2026-11-27');
    RAISE EXCEPTION 'schedule reminders contract: an unknown kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;

-- 4. The cron caller posts nothing while the switch is off, and once with the service
-- key at a 2 minute timeout while it is live.
BEGIN;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.reminder_posts(url text, body jsonb, headers jsonb, timeout_ms integer);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO pg_temp.reminder_posts VALUES (url, body, headers, timeout_milliseconds) RETURNING 1::bigint
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.reminders.fixture'::text $$;
SELECT public.trigger_job_schedule_reminders();
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_temp.reminder_posts) <> 0 THEN
    RAISE EXCEPTION 'schedule reminders contract: the cron posted with the switch off';
  END IF;
END $$;
UPDATE public.job_closeout_settings SET schedule_reminder_mode = 'live' WHERE id = 1;
SELECT public.trigger_job_schedule_reminders();
DO $$
DECLARE
  p record;
BEGIN
  SELECT * INTO p FROM pg_temp.reminder_posts;
  IF (SELECT count(*) FROM pg_temp.reminder_posts) <> 1
     OR p.url <> 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=job_schedule_reminder_sweep'
     OR p.headers->>'Authorization' <> 'Bearer eyJ.reminders.fixture'
     OR p.body->>'dry_run' <> 'false'
     OR p.timeout_ms <> 120000 THEN
    RAISE EXCEPTION 'schedule reminders contract: cron post %', row_to_json(p);
  END IF;
END $$;
ROLLBACK;

-- 5. The schedule, on a pg_cron stand-in: noon Perth (04:00 UTC) every day, once.
BEGIN;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL,
  active boolean NOT NULL DEFAULT true, jobname text);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid
$$;
\ir ../../../migrations/20261113120000_job_schedule_reminders.sql
\ir ../../../migrations/20261113120000_job_schedule_reminders.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'job-schedule-reminders') <> 1
     OR (SELECT schedule FROM cron.job WHERE jobname = 'job-schedule-reminders') <> '0 4 * * *'
     OR (SELECT command FROM cron.job WHERE jobname = 'job-schedule-reminders')
        <> 'SELECT public.trigger_job_schedule_reminders()' THEN
    RAISE EXCEPTION 'schedule reminders contract: the cron schedule is wrong';
  END IF;
END $$;
ROLLBACK;

-- 6. Re-applying the migration is a no-op and keeps the captain's switch.
BEGIN;
UPDATE public.job_closeout_settings SET schedule_reminder_mode = 'live' WHERE id = 1;
\ir ../../../migrations/20261113120000_job_schedule_reminders.sql
DO $$
BEGIN
  IF (SELECT schedule_reminder_mode FROM public.job_closeout_settings WHERE id = 1) <> 'live' THEN
    RAISE EXCEPTION 'schedule reminders contract: re-applying changed the switch';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_schedule_reminders') <> 1 THEN
    RAISE EXCEPTION 'schedule reminders contract: re-applying changed the policies';
  END IF;
END $$;
ROLLBACK;
