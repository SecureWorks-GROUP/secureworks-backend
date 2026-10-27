-- Dispatch v2, slice 8: run the supplier reply scan every five minutes.
--
-- The capture reader (outlook-mail-capture, cron outlook-mail-poll at minutes
-- 2, 7, 12 ...) saves admin@ mail into business_events as it always has. This
-- file adds a second, separate job one minute behind it, at minutes 3, 8, 13
-- ... (dispatch-v2-replies-scan). It posts ops-api
-- `dispatch_v2_replies_scan`, which reads the new inbound email rows, keeps
-- only the ones from a supplier and matches them to Dispatch orders. The
-- capture reader, and every email that is not from a supplier, are unchanged.
--
-- Off until switched on: the job does nothing while feature flag
-- dispatch_v2_replies_v1 is off (seeded off here), and nothing while the
-- capture automation lane is paused (the same switch that pauses the capture
-- reader).
--
-- The scan writes only the four dispatch_v2_* reply tables
-- (20261023230000_dispatch_v2_replies_tables.sql). No send, no job status, no
-- Xero, no supplier row.
--
-- Rollback: supabase/rollbacks/20261023230100_dispatch_v2_replies_schedule_down.sql.

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('dispatch_v2_replies_v1', false,
   'Dispatch v2 slice 8: every five minutes, match captured supplier emails to Dispatch orders and suggest delivery dates (Accept / Dismiss on the job). Reads mail only; sends nothing and never moves a job stage. Off until the captain says make it live.')
ON CONFLICT (flag_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.trigger_dispatch_v2_replies_scan()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'dispatch_v2_replies_v1' LIMIT 1), false) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=dispatch_v2_replies_scan',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'dispatch-v2-replies-scan-cron'
    ),
    body := jsonb_build_object('actor', 'dispatch-v2-replies-scan-cron'),
    timeout_milliseconds := 30000
  );
END $$;
COMMENT ON FUNCTION public.trigger_dispatch_v2_replies_scan() IS
  'pg_cron dispatch-v2-replies-scan (every 5 minutes, one minute after outlook-mail-poll): posts ops-api dispatch_v2_replies_scan with the service key while feature flag dispatch_v2_replies_v1 is on. Otherwise a no-op.';
REVOKE ALL ON FUNCTION public.trigger_dispatch_v2_replies_scan() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_dispatch_v2_replies_scan() TO service_role, postgres;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'dispatch v2 replies: pg_cron absent, scan not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-v2-replies-scan') THEN
    PERFORM cron.schedule('dispatch-v2-replies-scan', '3-59/5 * * * *',
      $cmd$SELECT public.trigger_dispatch_v2_replies_scan() WHERE public.automation_lane_enabled('capture')$cmd$);
  END IF;
END $cron$;
