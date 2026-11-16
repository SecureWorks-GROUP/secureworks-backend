-- Reminder texts before a scheduled job's first work day (captain, 13 Nov 2026: a text
-- every 7 days the job is still ahead, then one the day before; fixed wording; fencing,
-- patio and repair). The rules are ops-api job_schedule_reminders.ts.
--
--   1. job_closeout_settings.schedule_reminder_mode, 'off' or 'live', shipped 'off'.
--      Missing or unreadable is off. The captain switches it on:
--        UPDATE public.job_closeout_settings SET schedule_reminder_mode = 'live',
--          updated_by = '<who>', updated_at = now() WHERE id = 1;
--      The trigger below and ops-api both read it.
--   2. job_schedule_reminders: one row per job, recipient and Perth day, claimed by insert
--      before the text is sent (the unique key is the once-a-day guard), then the outcome.
--      Written only by ops-api.
--   3. job_schedule_reminder_runs: one row per live run (Perth day, outcome, how many
--      texts went, every outcome counted, and why each other job was not texted).
--   4. pg_cron job-schedule-reminders at 04:00 UTC, which is 12:00 in Perth (UTC+8, no
--      daylight saving), every day, posting ops-api job_schedule_reminder_sweep while the
--      switch is live.
-- Rollback: supabase/rollbacks/20261113120000_job_schedule_reminders_down.sql.

-- ── 1. The switch ────────────────────────────────────────────────────────────
-- IF NOT EXISTS so a re-apply never flips the captain's setting back.
ALTER TABLE public.job_closeout_settings
  ADD COLUMN IF NOT EXISTS schedule_reminder_mode text NOT NULL DEFAULT 'off'
    CONSTRAINT job_closeout_settings_schedule_reminder_mode_check
    CHECK (schedule_reminder_mode IN ('off', 'live'));

COMMENT ON COLUMN public.job_closeout_settings.schedule_reminder_mode IS
  'Scheduled-job reminder texts (20261113120000, ops-api job_schedule_reminders.ts): off | live, shipped off. live: at 12:00 Perth every day, a fencing, patio or repair job in Scheduled whose first work day is 7, 14, 21 ... days away gets the weekly text and 1 day away the day-before text. The database switch alone decides.';

-- ── 2. One row per text ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_schedule_reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  recipient_key  text NOT NULL,
  ghl_contact_id text,
  job_contact_id uuid,
  send_on        date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('weekly', 'day_before')),
  work_day       date NOT NULL,
  status         text NOT NULL DEFAULT 'claimed' CHECK (
    status IN ('claimed', 'sent', 'refused', 'unconfirmed', 'no_contact')
    OR status LIKE 'skipped\_%'
  ),
  message        text,
  ghl_message_id text,
  reason         text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  CONSTRAINT job_schedule_reminders_once_a_day
    UNIQUE (job_id, recipient_key, send_on)
);
CREATE INDEX IF NOT EXISTS job_schedule_reminders_send_on_idx
  ON public.job_schedule_reminders (send_on DESC);

COMMENT ON TABLE public.job_schedule_reminders IS
  'Scheduled-job reminder texts (20261113120000): one row per job, recipient (GHL contact id, else party:<job_contacts id>, else owner) and Perth send day, inserted with status claimed before the send (job_schedule_reminders_once_a_day: a second run that day finds it taken and sends nothing). Outcomes: sent, refused (a 4xx, nothing went), unconfirmed (may have reached GHL; never retried), no_contact, or skipped_<reason> (booking_changed_today, reschedule_text_today, similar_prior, contact_shared, and *_unreadable when a check could not be read). claimed means the run stopped before the outcome was written: never retried. Written only by ops-api job_schedule_reminders.ts.';

ALTER TABLE public.job_schedule_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_schedule_reminders FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_schedule_reminders TO service_role;
DROP POLICY IF EXISTS job_schedule_reminders_service_role_all ON public.job_schedule_reminders;
CREATE POLICY job_schedule_reminders_service_role_all ON public.job_schedule_reminders
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 3. The run log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_schedule_reminder_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_on     date NOT NULL,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  outcome    text NOT NULL CHECK (outcome IN ('ok', 'partial', 'failed')),
  sent_count integer NOT NULL DEFAULT 0,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS job_schedule_reminder_runs_run_on_idx
  ON public.job_schedule_reminder_runs (run_on DESC, ran_at DESC);

COMMENT ON TABLE public.job_schedule_reminder_runs IS
  'Scheduled-job reminder texts (20261113120000): one row per live run of ops-api job_schedule_reminder_sweep. run_on is the Perth day; outcome ok | partial (a text unconfirmed, a claim failed or a job failed) | failed (candidates unreadable); detail.outcomes counts every recipient outcome, detail.reminded lists each job texted or held with its recipients, detail.not_due lists every other candidate and why (not_due, no_work_booking, not_scheduled, make_safe_board, not_reminded_type). Written only by ops-api job_schedule_reminders.ts.';

ALTER TABLE public.job_schedule_reminder_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_schedule_reminder_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_schedule_reminder_runs TO service_role;
DROP POLICY IF EXISTS job_schedule_reminder_runs_service_role_all ON public.job_schedule_reminder_runs;
CREATE POLICY job_schedule_reminder_runs_service_role_all ON public.job_schedule_reminder_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. The caller and its pg_cron job ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trigger_job_schedule_reminders()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF COALESCE((SELECT s.schedule_reminder_mode FROM public.job_closeout_settings s
               WHERE s.id = 1 LIMIT 1), 'off') <> 'live' THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=job_schedule_reminder_sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'job-schedule-reminders-cron'
    ),
    body := jsonb_build_object('actor', 'job-schedule-reminders-cron', 'dry_run', false),
    timeout_milliseconds := 120000
  );
END $$;
COMMENT ON FUNCTION public.trigger_job_schedule_reminders() IS
  'pg_cron job-schedule-reminders (04:00 UTC = 12:00 Perth, every day): posts ops-api job_schedule_reminder_sweep with the service key while job_closeout_settings.schedule_reminder_mode is live. Otherwise a no-op. ops-api re-checks the switch before texting anyone.';
REVOKE ALL ON FUNCTION public.trigger_job_schedule_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_job_schedule_reminders() TO service_role, postgres;

-- Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'job schedule reminders: pg_cron absent, not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'job-schedule-reminders') THEN
    PERFORM cron.schedule('job-schedule-reminders', '0 4 * * *',
      $cmd$SELECT public.trigger_job_schedule_reminders()$cmd$);
  END IF;
END $cron$;
