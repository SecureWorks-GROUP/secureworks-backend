-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE PORTAL-RECHECK — enqueue cron (W2-C / M-E1, honest fallback)
-- Mission: makesafe-system wave-2-hardening-2026-07-07 (items 7 + 14)
-- ════════════════════════════════════════════════════════════
--
-- Server-side portal lock detection is NOT feasible safely (the primeeco share
-- page is a client-rendered SPA behind a private share-token login — see
-- 20260708000001_makesafe_portal_truth.sql). The detector is the reporting skill's
-- capture_portal_evidence.py run AGENT-SIDE. This cron maintains the durable
-- QUEUE that agent runs consume: it stamps a rate-limited recheck marker
-- (portal_recheck_requested_at / _count) on report-type cards that carry a portal
-- link and are not yet portal-verified this cycle, via the ops-api
-- `makesafe_portal_recheck_enqueue` action. MARKER-ONLY: it never advances a
-- substatus, never drafts an invoice, never sends anything.
--
-- Gate: reuses public.makesafe_cron_enabled() (20260614000001). INERT until an
-- owner enables the make-safe cron gate — a plain `db push` registers the schedule
-- but the trigger no-ops. Idempotent: guarded unschedule precedes the schedule.

-- ── Trigger: invoke the enqueue action over HTTP with the vault service key ──
CREATE OR REPLACE FUNCTION public.trigger_makesafe_portal_recheck() RETURNS void AS $$
DECLARE
  svc_key text;
BEGIN
  -- Hard gate: no-op until an owner enables the make-safe cron.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_portal_recheck: cron gate disabled; skipping';
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_portal_recheck_enqueue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    -- min_interval_hours: don't re-stamp a card more often than every 6h.
    body := jsonb_build_object('min_interval_hours', 6)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.trigger_makesafe_portal_recheck IS
  'Calls ops-api makesafe_portal_recheck_enqueue via pg_net with the vault service
   key: stamps a rate-limited recheck marker on report-type cards awaiting portal
   verification. Marker-only; gated by makesafe_cron_enabled().';

-- ── Lock down the definer trigger (no anon/authenticated execute) ──
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_portal_recheck() FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_portal_recheck() FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_portal_recheck() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.trigger_makesafe_portal_recheck() TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.trigger_makesafe_portal_recheck() TO postgres';
END $$;

-- ── Idempotent (re)schedule — every 6 hours, off the top of the hour ──
DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-portal-recheck')
    FROM cron.job WHERE jobname = 'makesafe-portal-recheck';
END $$;

SELECT cron.schedule(
  'makesafe-portal-recheck',
  '17 */6 * * *',
  $$SELECT public.trigger_makesafe_portal_recheck()$$
);
