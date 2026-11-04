-- Scheduled -> In Progress on a booked work day (captain, 2 Nov 2026: every job
-- type, "all. even repairs"; 6am Perth; no catch-up; no client text). A quick fix until
-- the Trade App's Start press moves a job. The rules are ops-api job_auto_start.ts.
--
--   1. feature_flags.job_auto_start_v1, seeded ON so the first run is the morning after
--      this applies. Off: UPDATE public.feature_flags SET enabled = false
--      WHERE flag_name = 'job_auto_start_v1'. The trigger and ops-api both read it.
--   2. job_auto_start_runs: one row per live run (Perth day, outcome, how many moved,
--      their job numbers, and what was not moved and why). Written only by ops-api.
--   3. pg_cron job-auto-start at 22:00 UTC, which is 06:00 the next day in Perth
--      (UTC+8, no daylight saving), posting ops-api job_auto_start_sweep.
--
-- A move goes through the same ops-api writers as a hand move on the Ops Dash
-- (update_job_status with compare and set on 'scheduled'; a repair's board stage through
-- update_repair_stage with compare and set on 'scheduled'), so it records a
-- status_changed (or repair_stage_changed) job event with source auto_schedule_start.
-- Rollback: supabase/rollbacks/20261105010000_job_auto_start_down.sql.

-- ── 1. The switch ────────────────────────────────────────────────────────────
-- DO NOTHING so a re-apply never flips an operator's setting back.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('job_auto_start_v1', true,
   'At 6am Perth move every job still at Scheduled that has a crew work booking today to In Progress (repairs: Repairs board scheduled -> on_site). No catch-up, no client text. ops-api job_auto_start.ts; pg_cron job-auto-start.')
ON CONFLICT (flag_name) DO NOTHING;

-- ── 2. The run log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_auto_start_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_on            date NOT NULL,
  ran_at            timestamptz NOT NULL DEFAULT now(),
  outcome           text NOT NULL CHECK (outcome IN ('ok', 'partial', 'failed')),
  moved_count       integer NOT NULL DEFAULT 0,
  moved_job_numbers jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS job_auto_start_runs_run_on_idx
  ON public.job_auto_start_runs (run_on DESC, ran_at DESC);

COMMENT ON TABLE public.job_auto_start_runs IS
  'The 6am auto start (20261105010000): one row per live run of ops-api job_auto_start_sweep. run_on is the Perth day; outcome ok | partial (a move failed) | failed (candidates unreadable); moved_job_numbers lists the jobs moved to In Progress; detail.not_moved lists every other candidate and why (booked_earlier_only, starts_later, not_booked_today, no_work_booking, skipped, status_changed, ...). Written only by ops-api job_auto_start.ts.';

ALTER TABLE public.job_auto_start_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_auto_start_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_auto_start_runs TO service_role;
DROP POLICY IF EXISTS job_auto_start_runs_service_role_all ON public.job_auto_start_runs;
CREATE POLICY job_auto_start_runs_service_role_all ON public.job_auto_start_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 3. The caller and its pg_cron job ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trigger_job_auto_start()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_auto_start_v1' LIMIT 1), false) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=job_auto_start_sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'job-auto-start-cron'
    ),
    body := jsonb_build_object('actor', 'job-auto-start-cron', 'dry_run', false),
    timeout_milliseconds := 30000
  );
END $$;
COMMENT ON FUNCTION public.trigger_job_auto_start() IS
  'pg_cron job-auto-start (22:00 UTC = 06:00 Perth): posts ops-api job_auto_start_sweep with the service key while feature flag job_auto_start_v1 is on. Otherwise a no-op. ops-api re-checks the flag before moving anything.';
REVOKE ALL ON FUNCTION public.trigger_job_auto_start() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_job_auto_start() TO service_role, postgres;

-- Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'job auto start: pg_cron absent, not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'job-auto-start') THEN
    PERFORM cron.schedule('job-auto-start', '0 22 * * *',
      $cmd$SELECT public.trigger_job_auto_start()$cmd$);
  END IF;
END $cron$;
