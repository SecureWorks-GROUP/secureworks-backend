-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE HYBRID LOOP — cron (W3-A, 2026-07-08 overnight)
-- Mission: makesafe-system wave-3-hybrid-loop-2026-07-08 (M-E standing loop)
-- ════════════════════════════════════════════════════════════
--
-- Registers the two schedules the hybrid standing loop needs, both marker/read
-- only. They extend the existing 30-min make-safe reconcile cadence:
--
--   1. makesafe-sent-mirror   — mirrors the admin@ Sent-Items folder into `emails`
--      (folder='sentitems'). Incremental delta off mail_sync_cursors; 90-day
--      bounded backfill on first run. Unlocks backend send-attribution.
--
--   2. makesafe-story-recompute — the cheap pass: for ACTIVE make-safe cards,
--      computes the backend-honest story verdict + evidence gaps into
--      makesafe_card_story, and stamps cards needing portal/mail legs into the
--      EXISTING W2-C recheck queue. NEVER advances substatus, drafts, sends, or
--      SMSs (item-14 guard is law).
--
-- Offsets: sent-mirror at :05/:35 runs ~20 min before story-recompute at :25/:55
-- so each cheap pass usually sees fresh outbound mail. Ordering is best-effort;
-- the story delta rule recomputes on the next cheap-signal change regardless.
--
-- Gate: reuses public.makesafe_cron_enabled() (20260614000001). INERT until an
-- owner enables the make-safe cron gate — a plain `db push` registers the
-- schedules but the triggers no-op. Idempotent: guarded unschedule precedes each
-- schedule. These call the ops-api actions over HTTP with the vault service key,
-- the same auth path as the existing reconcile/recheck triggers.

-- ── Trigger: admin@ Sent-Items mirror ──
CREATE OR REPLACE FUNCTION public.trigger_makesafe_sent_mirror() RETURNS void AS $$
DECLARE
  svc_key text;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_sent_mirror: cron gate disabled; skipping';
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_sent_mirror',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.trigger_makesafe_sent_mirror IS
  'Calls ops-api makesafe_sent_mirror via pg_net with the vault service key:
   mirrors the admin@ Sent-Items folder into emails (folder=sentitems) for backend
   send-attribution. Read/mirror only; gated by makesafe_cron_enabled().';

-- ── Trigger: cheap-pass story recompute ──
CREATE OR REPLACE FUNCTION public.trigger_makesafe_story_recompute() RETURNS void AS $$
DECLARE
  svc_key text;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_story_recompute: cron gate disabled; skipping';
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_story_recompute',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    -- stale_hours: recompute a card even with unchanged signals once its verdict is
    -- older than this (the DESIGN >24h staleness half of the delta rule).
    body := jsonb_build_object('stale_hours', 24)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.trigger_makesafe_story_recompute IS
  'Calls ops-api makesafe_story_recompute via pg_net with the vault service key:
   the cheap backend pass. Computes backend-honest story verdicts into
   makesafe_card_story and stamps cards needing agent legs into the W2-C recheck
   queue. Marker/read only — never advances substatus, drafts, sends, or SMSs.
   Gated by makesafe_cron_enabled().';

-- ── Lock down the definer triggers (no anon/authenticated execute) ──
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.trigger_makesafe_sent_mirror()',
    'public.trigger_makesafe_story_recompute()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', fn);
  END LOOP;
END $$;

-- ── Idempotent (re)schedule ──
DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-sent-mirror')
    FROM cron.job WHERE jobname = 'makesafe-sent-mirror';
  PERFORM cron.unschedule('makesafe-story-recompute')
    FROM cron.job WHERE jobname = 'makesafe-story-recompute';
END $$;

-- Sent-Items mirror at :05 and :35 (a touch ahead of the story pass).
SELECT cron.schedule(
  'makesafe-sent-mirror',
  '5,35 * * * *',
  $$SELECT public.trigger_makesafe_sent_mirror()$$
);

-- Cheap-pass story recompute at :25 and :55 (after the mirror has landed).
SELECT cron.schedule(
  'makesafe-story-recompute',
  '25,55 * * * *',
  $$SELECT public.trigger_makesafe_story_recompute()$$
);
