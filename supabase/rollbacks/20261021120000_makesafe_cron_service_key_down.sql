-- Rollback of 20261021120000_makesafe_cron_service_key.sql: restores the six
-- bodies read live on 21 Oct 2026 (from 20260614000004, 20260708000002,
-- 20260709000002 and 20260723000001), which read vault.decrypted_secrets
-- 'service_role_key' raw. Grants and comments are kept.

CREATE OR REPLACE FUNCTION public.trigger_makesafe_reconcile(p_action text) RETURNS void AS $$
DECLARE
  svc_key text;
BEGIN
  -- M4 — hard gate: no-op until an owner enables the cron. Applying this migration
  -- registers the D1/D2/D3/D4 schedules but does NOT start reconcile/Graph traversal.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_reconcile(%): cron gate disabled; skipping', p_action;
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=' || p_action,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.trigger_makesafe_status_canary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  svc_key text;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_status_canary: cron gate disabled; skipping';
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_status_canary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    body := '{}'::jsonb
  );
END;
$$;

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

CREATE OR REPLACE FUNCTION public.trigger_makesafe_status_shadow_refresh()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  svc_key text;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_status_shadow_refresh: cron gate disabled; skipping';
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_status_shadow_refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    body := '{}'::jsonb
  );
END;
$$;
