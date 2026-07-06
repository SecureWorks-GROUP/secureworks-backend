-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE SES POLL — cadence 5 min → 2 min (Captain D2)
-- Mission: makesafe/intake-resurrect-harden (Auto-Intake v2 Wave 1 M1)
-- ════════════════════════════════════════════════════════════
--
-- Captain-locked D2: 2-minute poll. This reschedules ONLY the makesafe-ses-poll
-- cron job from '*/5 * * * *' to '*/2 * * * *'. Everything else is unchanged:
--   - the cron_enabled gate stays (trigger_monitor_ses_makesafes no-ops until an
--     owner sets makesafe_cron_settings.cron_enabled = true — a bare db push does
--     NOT start polling),
--   - the trigger function, its auth, and the daily purge schedule are untouched.
--
-- Idempotent: the unschedule is guarded on jobname presence, so re-applying just
-- replaces the schedule rather than erroring on a duplicate jobname.
--
-- ⚠ LIVE-SCHEMA DRIFT (M0 risk 4). The migration history is NOT guaranteed to be
-- the source of truth for the live cron.job row — the running schedule can drift
-- from migrations/. At DEPLOY time, VERIFY (and if needed apply) the live cadence
-- via the Management-API single-SQL path, do NOT assume this file already took
-- effect:
--
--   -- verify the live schedule:
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'makesafe-ses-poll';
--   -- expected: '*/2 * * * *'
--
--   -- if it still reads '*/5 * * * *', apply live (single statement):
--   SELECT cron.schedule('makesafe-ses-poll', '*/2 * * * *',
--     $$SELECT public.trigger_monitor_ses_makesafes()$$);
--
-- cron.schedule() UPSERTS by jobname, so re-scheduling an existing job updates its
-- cadence in place (no unschedule required live).

DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-ses-poll')
    FROM cron.job WHERE jobname = 'makesafe-ses-poll';
END $$;

-- Poll every 2 minutes (Captain D2). Group mailboxes cannot do reliable push, so
-- 2 minutes is effectively immediate for make-safe intake.
SELECT cron.schedule(
  'makesafe-ses-poll',
  '*/2 * * * *',
  $$SELECT public.trigger_monitor_ses_makesafes()$$
);
