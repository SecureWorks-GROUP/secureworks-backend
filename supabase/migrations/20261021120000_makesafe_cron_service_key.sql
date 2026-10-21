-- The make-safe ops-api crons post the cleaned service key.
--
-- These triggers read vault.decrypted_secrets 'service_role_key' raw:
--   trigger_makesafe_reconcile(text)         crons makesafe-reconcile-d1, -d2,
--                                            -d3 and makesafe-canary-d4
--   trigger_makesafe_status_canary()         cron makesafe-status-canary
--   trigger_makesafe_portal_recheck()        cron makesafe-portal-recheck
--   trigger_makesafe_sent_mirror()           cron makesafe-sent-mirror
--   trigger_makesafe_story_recompute()       cron makesafe-story-recompute
--   trigger_makesafe_status_shadow_refresh() cron makesafe-status-shadow-refresh
-- That secret is stored line-wrapped (20260717000001_cron_vault_service_key.sql,
-- "WHITESPACE DEFENCE"), so the raw read is a malformed bearer and ops-api
-- answers 401 on every run: the reconcile jobs have never got through, and the
-- canaries still 401 after #1125 admitted their service-role claim.
-- trigger_makesafe_draft_pack_due is left alone: no cron job calls it.
-- public.sw_service_key() strips the whitespace and checks the JWT shape; it is
-- what trigger_job_work_order_auto_issue posts, and that cron gets 200.
--
-- Each body changes in one place only: the vault read becomes
-- `'Bearer ' || public.sw_service_key()`. The makesafe_cron_enabled() gate, URL,
-- body, security definer, search_path, grants and comments are unchanged
-- (CREATE OR REPLACE keeps the comments; the grants are restated below exactly
-- as production holds them, read live on 21 Oct 2026). No schedule changes.
-- Rollback: supabase/rollbacks/20261021120000_makesafe_cron_service_key_down.sql.

CREATE OR REPLACE FUNCTION public.trigger_makesafe_reconcile(p_action text) RETURNS void AS $$
BEGIN
  -- M4 — hard gate: no-op until an owner enables the cron. Applying this migration
  -- registers the D1/D2/D3/D4 schedules but does NOT start reconcile/Graph traversal.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_reconcile(%): cron gate disabled; skipping', p_action;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=' || p_action,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
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
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_status_canary: cron gate disabled; skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_status_canary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
    ),
    body := '{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_makesafe_portal_recheck() RETURNS void AS $$
BEGIN
  -- Hard gate: no-op until an owner enables the make-safe cron.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_portal_recheck: cron gate disabled; skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_portal_recheck_enqueue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
    ),
    -- min_interval_hours: don't re-stamp a card more often than every 6h.
    body := jsonb_build_object('min_interval_hours', 6)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.trigger_makesafe_sent_mirror() RETURNS void AS $$
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_sent_mirror: cron gate disabled; skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_sent_mirror',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.trigger_makesafe_story_recompute() RETURNS void AS $$
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_story_recompute: cron gate disabled; skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_story_recompute',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
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
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_status_shadow_refresh: cron gate disabled; skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_status_shadow_refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
    ),
    body := '{}'::jsonb
  );
END;
$$;

-- The grants production already holds, restated so the migration stands alone.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.trigger_makesafe_reconcile(text)',
    'public.trigger_makesafe_status_canary()',
    'public.trigger_makesafe_portal_recheck()',
    'public.trigger_makesafe_sent_mirror()',
    'public.trigger_makesafe_story_recompute()',
    'public.trigger_makesafe_status_shadow_refresh()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres', fn);
  END LOOP;
END $$;
