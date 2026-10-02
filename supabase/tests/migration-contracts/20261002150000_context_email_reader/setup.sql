-- EM2/EM3 setup. Earlier registered fixtures supply business_events, jobs
-- (with client_email and job_number), feature_flags (live shape),
-- monitored_mailboxes (EM1), context_capture_runs and record_capture_run()
-- (F1b), capture_business_event() (C1a), automation_switch_cron_lanes() (T2)
-- and context_ghl_history_live_jobs() (M4).
--
-- Adds the one live table no earlier fixture creates: suppliers (its email
-- column, as live).
CREATE TABLE IF NOT EXISTS public.suppliers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text,
 email text
);

-- Prove the fixtures leave exactly the pre-image the migration's guard pins.
DO $$
BEGIN
 IF to_regclass('public.context_email_attachments') IS NOT NULL
  OR to_regprocedure('public.context_email_reader_flags()') IS NOT NULL
 THEN RAISE EXCEPTION 'em2 setup: a new object already exists'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1'))
 THEN RAISE EXCEPTION 'em2 setup: a reader flag row already exists'; END IF;
END $$;
