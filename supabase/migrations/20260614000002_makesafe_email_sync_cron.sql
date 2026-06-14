-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE EMAIL SYNC — cron enable (Phase 1, Stage C / apply-LAST)
-- Mission: makesafe-live-truth-2026-06-14
-- ════════════════════════════════════════════════════════════
--
-- This is the APPLY-LAST migration. It enables automation:
--   1. makesafe-ses-poll       — */5  group-poll of ses@ into the sync store
--   2. makesafe-email-purge    — daily 90-day PII purge-or-tombstone
--
-- Per MISSION.md Stage C, this migration is applied ONLY after:
--   - the schema migration (20260614000001) is applied and verified,
--   - a manual read-only smoke run has passed (Stage B),
--   - Graph app-permission consent is confirmed by tenant admin,
--   - Marnin owner approval is given.
--
-- It is idempotent: each cron.schedule is preceded by a guarded unschedule, so
-- re-applying the migration replaces the schedule rather than erroring on a
-- duplicate jobname.
--
-- M4 GATE: applying this migration only REGISTERS the schedules. Both trigger
-- functions no-op until an owner explicitly enables the gate (defined in
-- 20260614000001). A plain `db push` therefore does NOT start live polling. To go
-- live (Stage C), after consent + approval, run the single owner statement:
--   UPDATE public.makesafe_cron_settings
--      SET cron_enabled = true, enabled_at = now(), enabled_by = '<owner>';
--
-- Auth: net.http_post with `_sw_service_key()` (same pattern as
-- trigger_monitor_inbox in 20260405000003_inbox_events.sql).

-- ── Trigger: invoke the monitor-ses-makesafes edge function ──
CREATE OR REPLACE FUNCTION public.trigger_monitor_ses_makesafes() RETURNS void AS $$
BEGIN
  -- M4 — hard gate: no-op until an owner sets makesafe_cron_settings.cron_enabled.
  -- Applying this migration registers the schedule but does NOT start live polling.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_monitor_ses_makesafes: cron gate disabled; skipping poll';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/monitor-ses-makesafes',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;  -- B6: pin search_path on definer fn

COMMENT ON FUNCTION public.trigger_monitor_ses_makesafes IS
  'Group-poll the ses@ M365 group for make-safe emails. Called by pg_cron every 5 min.';

-- ── Trigger: daily 90-day PII purge-or-tombstone ──
CREATE OR REPLACE FUNCTION public.trigger_makesafe_email_purge() RETURNS void AS $$
DECLARE
  result jsonb;
BEGIN
  -- M4 — hard gate: no-op until the owner enables the cron. A bare db push must
  -- never start tombstoning PII on a schedule.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_email_purge: cron gate disabled; skipping purge';
    RETURN;
  END IF;
  -- 90 is the policy default; the callee clamps it to the safe 30..365 band.
  result := public.purge_makesafe_email_pii(90);
  RAISE NOTICE 'trigger_makesafe_email_purge: %', result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;  -- B6: pin search_path on definer fn

COMMENT ON FUNCTION public.trigger_makesafe_email_purge IS
  'Daily make-safe email-sync PII purge (90-day tombstone). Called by pg_cron.';

-- ── B6: revoke execute from PUBLIC/anon/authenticated on the definer triggers;
--    grant only to service_role + postgres. These fire pg_net with the service
--    key, so they must never be invocable by an untrusted role. ──
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.trigger_monitor_ses_makesafes()',
    'public.trigger_makesafe_email_purge()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC;', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon;', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated;', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres;', fn);
  END LOOP;
END $$;

-- ── Idempotent (re)schedule ──
-- cron.unschedule errors if the job does not exist, so guard each call by
-- selecting only jobnames that are actually present before unscheduling.
DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-ses-poll')
    FROM cron.job WHERE jobname = 'makesafe-ses-poll';
  PERFORM cron.unschedule('makesafe-email-purge')
    FROM cron.job WHERE jobname = 'makesafe-email-purge';
END $$;

-- Poll every 5 minutes (cadence per MISSION.md open question (c); */5 chosen).
SELECT cron.schedule(
  'makesafe-ses-poll',
  '*/5 * * * *',
  $$SELECT public.trigger_monitor_ses_makesafes()$$
);

-- Daily purge at 18:00 UTC (02:00 AWST) — off-peak.
SELECT cron.schedule(
  'makesafe-email-purge',
  '0 18 * * *',
  $$SELECT public.trigger_makesafe_email_purge()$$
);
